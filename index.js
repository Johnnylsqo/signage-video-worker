import express from "express";

const app = express();

app.get("/", (req, res) => {
  res.status(200).send("worker online");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Worker rodando na porta ${PORT}`);
});
