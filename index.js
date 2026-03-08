import express from "express";
import { createClient } from "@supabase/supabase-js";
import { exec } from "child_process";
import fs from "fs";
import crypto from "crypto";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WORKER_SECRET = process.env.WORKER_SECRET;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function execCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject({
          error,
          stdout,
          stderr
        });
        return;
      }

      resolve({
        stdout,
        stderr
      });
    });
  });
}

function sha256File(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(fileBuffer).digest("hex");
}

function safeUnlink(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

app.get("/", (req, res) => {
  res.send("worker online");
});

app.post("/transcode", async (req, res) => {
  let tempInput = null;
  let tempOutput = null;

  try {
    if (req.headers["x-worker-secret"] !== WORKER_SECRET) {
      return res.status(401).send("unauthorized");
    }

    const { mediaId } = req.body;

    if (!mediaId) {
      return res.status(400).send("mediaId required");
    }

    const { data: media, error: mediaError } = await supabase
      .from("media_assets")
      .select("*")
      .eq("id", mediaId)
      .single();

    if (mediaError || !media) {
      console.error("Supabase error:", mediaError);
      return res.status(500).json({
        ok: false,
        message: "db error",
        details: mediaError?.message || "media not found"
      });
    }

    if (media.status === "ready") {
      return res.json({
        ok: true,
        message: "already processed",
        playablePath: media.playable_path || null
      });
    }

    if (!media.original_path) {
      return res.status(400).json({
        ok: false,
        message: "original_path missing"
      });
    }

    await supabase
      .from("media_assets")
      .update({
        status: "processing",
        error_message: null
      })
      .eq("id", mediaId);

    const bucketName = "media";
    tempInput = `/tmp/${mediaId}-input`;
    tempOutput = `/tmp/${mediaId}-output.mp4`;

    const { data: fileData, error: downloadError } = await supabase
      .storage
      .from(bucketName)
      .download(media.original_path);

    if (downloadError || !fileData) {
      console.error("Download error:", downloadError);

      await supabase
        .from("media_assets")
        .update({
          status: "failed",
          error_message: downloadError?.message || "download failed"
        })
        .eq("id", mediaId);

      return res.status(500).json({
        ok: false,
        message: "download failed",
        details: downloadError?.message
      });
    }

    const inputBuffer = Buffer.from(await fileData.arrayBuffer());
    fs.writeFileSync(tempInput, inputBuffer);

    // 1) Analisa o vídeo com ffprobe
    const ffprobeCommand = `ffprobe -v quiet -print_format json -show_format -show_streams "${tempInput}"`;
    const ffprobeResult = await execCommand(ffprobeCommand);

    let probe;
    try {
      probe = JSON.parse(ffprobeResult.stdout);
    } catch (parseError) {
      await supabase
        .from("media_assets")
        .update({
          status: "failed",
          error_message: "ffprobe parse failed"
        })
        .eq("id", mediaId);

      safeUnlink(tempInput);
      safeUnlink(tempOutput);

      return res.status(500).json({
        ok: false,
        message: "ffprobe parse failed"
      });
    }

    const videoStream = probe.streams?.find((s) => s.codec_type === "video");
    const audioStream = probe.streams?.find((s) => s.codec_type === "audio");
    const format = probe.format;

    const videoCodec = videoStream?.codec_name || null;
    const audioCodec = audioStream?.codec_name || null;
    const width = videoStream?.width || null;
    const height = videoStream?.height || null;
    const durationMs = format?.duration
      ? Math.round(parseFloat(format.duration) * 1000)
      : null;
    const formatName = format?.format_name || "";
    const mimeType = "video/mp4";

    // 2) Decide estratégia
    const isMp4Like =
      formatName.includes("mov") ||
      formatName.includes("mp4") ||
      formatName.includes("m4a") ||
      formatName.includes("3gp") ||
      formatName.includes("3g2") ||
      formatName.includes("mj2");

    const isVideoCompatible = videoCodec === "h264";
    const isAudioCompatible = !audioStream || audioCodec === "aac";
    const isResolutionCompatible =
      width !== null &&
      height !== null &&
      width <= 1920 &&
      height <= 1080;

    const canUseCopyFaststart =
      isMp4Like &&
      isVideoCompatible &&
      isAudioCompatible &&
      isResolutionCompatible;

    let ffmpegCommand = "";
    let processingMode = "";

    if (canUseCopyFaststart) {
      processingMode = "copy_faststart";
      ffmpegCommand = `ffmpeg -y -threads 1 -i "${tempInput}" -c copy -movflags +faststart "${tempOutput}"`;
    } else {
      processingMode = "reencode";
      ffmpegCommand = `ffmpeg -y -threads 2 -i "${tempInput}" -vf "scale='min(1280,iw)':-2" -c:v libx264 -preset ultrafast -crf 26 -profile:v main -level 4.0 -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart "${tempOutput}"`;
    }

    // 3) Executa FFmpeg
    try {
      await execCommand(ffmpegCommand);
    } catch (ffmpegExecError) {
      console.error("FFmpeg error:", ffmpegExecError);

      await supabase
        .from("media_assets")
        .update({
          status: "failed",
          error_message: ffmpegExecError?.stderr || ffmpegExecError?.error?.message || "ffmpeg failed"
        })
        .eq("id", mediaId);

      safeUnlink(tempInput);
      safeUnlink(tempOutput);

      return res.status(500).json({
        ok: false,
        message: "ffmpeg failed",
        details:
          ffmpegExecError?.stderr ||
          ffmpegExecError?.error?.message ||
          "unknown ffmpeg error"
      });
    }

    // 4) Gera hash e sobe output
    const outputBuffer = fs.readFileSync(tempOutput);
    const playablePath = `playable/${mediaId}.mp4`;
    const fileSizePlayable = outputBuffer.length;
    const checksumPlayable = sha256File(tempOutput);

    const { error: uploadError } = await supabase
      .storage
      .from(bucketName)
      .upload(playablePath, outputBuffer, {
        contentType: "video/mp4",
        upsert: true
      });

    if (uploadError) {
      console.error("Upload error:", uploadError);

      await supabase
        .from("media_assets")
        .update({
          status: "failed",
          error_message: uploadError.message
        })
        .eq("id", mediaId);

      safeUnlink(tempInput);
      safeUnlink(tempOutput);

      return res.status(500).json({
        ok: false,
        message: "upload failed",
        details: uploadError.message
      });
    }

    // 5) Atualiza banco com metadados
    await supabase
      .from("media_assets")
      .update({
        status: "ready",
        playable_path: playablePath,
        file_size_playable: fileSizePlayable,
        processed_at: new Date().toISOString(),
        error_message: null,
        video_codec: videoCodec,
        audio_codec: audioCodec,
        width,
        height,
        duration_ms: durationMs,
        mime_type: mimeType,
        checksum_playable: checksumPlayable,
        processing_mode: processingMode
      })
      .eq("id", mediaId);

    safeUnlink(tempInput);
    safeUnlink(tempOutput);

    return res.json({
      ok: true,
      playablePath,
      processingMode,
      metadata: {
        videoCodec,
        audioCodec,
        width,
        height,
        durationMs
      }
    });
  } catch (err) {
    console.error("Internal error:", err);

    if (req.body?.mediaId) {
      await supabase
        .from("media_assets")
        .update({
          status: "failed",
          error_message: err.message
        })
        .eq("id", req.body.mediaId);
    }

    safeUnlink(tempInput);
    safeUnlink(tempOutput);

    return res.status(500).json({
      ok: false,
      message: "internal error",
      details: err.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Worker rodando na porta ${PORT}`);
});
