import express from "express"
import { exec } from "child_process"
import fs from "fs"
import fetch from "node-fetch"
import { createClient } from "@supabase/supabase-js"

const app = express()
app.use(express.json())

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const WORKER_SECRET = process.env.WORKER_SECRET

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

app.post("/transcode", async (req,res)=>{

 if(req.headers["x-worker-secret"] !== WORKER_SECRET){
   return res.status(401).send("unauthorized")
 }

 const { mediaId } = req.body

 const { data } = await supabase
  .from("media_assets")
  .select("*")
  .eq("id",mediaId)
  .single()

 const originalPath = data.original_path

 const tempInput = "/tmp/input.mp4"
 const tempOutput = "/tmp/output.mp4"

 const { data: file } = await supabase
   .storage
   .from("media")
   .download(originalPath)

 fs.writeFileSync(tempInput, Buffer.from(await file.arrayBuffer()))

 const command = `
 ffmpeg -i ${tempInput} \
 -vf "scale='min(1920,iw)':-2" \
 -c:v libx264 -preset veryfast -crf 22 \
 -pix_fmt yuv420p \
 -c:a aac -b:a 128k \
 -movflags +faststart \
 ${tempOutput}
 `

 exec(command, async (err)=>{

   if(err){
     await supabase
       .from("media_assets")
       .update({status:"failed"})
       .eq("id",mediaId)

     return res.send("error")
   }

   const fileBuffer = fs.readFileSync(tempOutput)

   const playablePath = `playable/${mediaId}.mp4`

   await supabase
     .storage
     .from("media")
     .upload(playablePath,fileBuffer,{upsert:true})

   await supabase
     .from("media_assets")
     .update({
       status:"ready",
       playable_path: playablePath
     })
     .eq("id",mediaId)

   res.send("ok")

 })

})

app.listen(3000)
