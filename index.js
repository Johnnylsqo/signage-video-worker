import express from "express";
import { createClient } from "@supabase/supabase-js";
import { exec } from "child_process";
import fs from "fs";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WORKER_SECRET = process.env.WORKER_SECRET;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

app.get("/", (req, res) => {
  res.send("worker online");
});

app.post("/transcode", async (req, res) => {
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

    if (!media.original_path) {
      return res.status(400).json({
        ok: false,
        message: "original_path missing"
      });
    }

    await supabase
      .from("media_assets")
      .update({ status: "processing", error_message: null })
      .eq("id", mediaId);

    const bucketName = "media";
    const tempInput = `/tmp/${mediaId}-input`;
    const tempOutput = `/tmp/${mediaId}-output.mp4`;

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

    const fileBuffer = Buffer.from(await fileData.arrayBuffer());
    fs.writeFileSync(tempInput, fileBuffer);

    const ffmpegCommand = `ffmpeg -y -threads 2 -i "${tempInput}" -vf "scale='min(1280,iw)':-2" -c:v libx264 -preset ultrafast -crf 26 -profile:v main -level 4.0 -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart "${tempOutput}"`;

    exec(ffmpegCommand, async (ffmpegError) => {
      if (ffmpegError) {
        console.error("FFmpeg error:", ffmpegError);

        await supabase
          .from("media_assets")
          .update({
            status: "failed",
            error_message: ffmpegError.message
          })
          .eq("id", mediaId);

        return res.status(500).json({
          ok: false,
          message: "ffmpeg failed",
          details: ffmpegError.message
        });
      }

      const outputBuffer = fs.readFileSync(tempOutput);
      const playablePath = `playable/${mediaId}.mp4`;

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

        return res.status(500).json({
          ok: false,
          message: "upload failed",
          details: uploadError.message
        });
      }

      const fileSizePlayable = outputBuffer.length;

      await supabase
        .from("media_assets")
        .update({
          status: "ready",
          playable_path: playablePath,
          file_size_playable: fileSizePlayable,
          processed_at: new Date().toISOString(),
          error_message: null
        })
        .eq("id", mediaId);

      try {
        fs.unlinkSync(tempInput);
        fs.unlinkSync(tempOutput);
      } catch {}

      return res.json({
        ok: true,
        playablePath
      });
    });

  } catch (err) {
    console.error("Internal error:", err);
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
