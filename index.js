import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// variáveis do Railway
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WORKER_SECRET = process.env.WORKER_SECRET;

// cliente Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// rota básica
app.get("/", (req, res) => {
  res.send("worker online");
});

// rota de teste de transcode
app.post("/transcode", async (req, res) => {
  try {

    if (req.headers["x-worker-secret"] !== WORKER_SECRET) {
      return res.status(401).send("unauthorized");
    }

    const { mediaId } = req.body;

    if (!mediaId) {
      return res.status(400).send("mediaId required");
    }

    const { data, error } = await supabase
      .from("media_assets")
      .select("*")
      .eq("id", mediaId)
      .single();

    if (error) {
      console.error(error);
      return res.status(500).send("db error");
    }

    res.json({
      ok: true,
      media: data
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("internal error");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Worker rodando na porta ${PORT}`);
});
