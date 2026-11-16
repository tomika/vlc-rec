const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { createContext, runInContext } = require("node:vm");

function previewHarness(native = true, workerAutoReady = true, configureThrows = false) {
  const sockets = [], workers = [], decoders = [], drawings = [], errors = [], shown = [];
  class FakeSocket {
    constructor(url) { this.url = url; sockets.push(this); }
    close() { this.closed = true; }
    message(data) { this.onmessage({ data }); }
  }
  class FakeWorker {
    constructor() { this.messages = []; workers.push(this); }
    postMessage(data) { this.messages.push(data); if (data.type === "init" && workerAutoReady) queueMicrotask(() => this.onmessage({data:{type:"ready"}})); }
    terminate() { this.closed = true; }
    output(data) { this.onmessage({data}); }
  }
  class FakeDecoder {
    static async isConfigSupported(config) { return {supported:true,config}; }
    constructor(callbacks) { this.callbacks = callbacks; this.chunks = []; this.decodeQueueSize = 0; decoders.push(this); }
    configure(config) { this.config = config; if (configureThrows) throw new Error("unsupported configuration"); }
    decode(chunk) { this.chunks.push(chunk); }
    reset() { this.resetCount = (this.resetCount || 0) + 1; }
    close() { this.closed = true; }
    output(timestamp) { this.callbacks.output({timestamp,displayWidth:64,displayHeight:64,close(){}}); }
  }
  class Pixels { constructor(data,width,height) { Object.assign(this,{data,width,height}); } }
  const canvas={width:0,height:0,getContext(){return {drawImage(){drawings.push("video");},putImageData(){drawings.push("pixels");},strokeRect(...rect){drawings.push(rect);},beginPath(){},moveTo(){},lineTo(){},stroke(){}};}};
  const context=createContext({WebSocket:FakeSocket,Worker:FakeWorker,VideoDecoder:native?FakeDecoder:undefined,
    EncodedVideoChunk:class{constructor(value){Object.assign(this,value);}},ImageData:Pixels,ArrayBuffer,Uint8ClampedArray,URL,
    setTimeout,clearTimeout,setInterval(){return 1;},clearInterval(){}});
  runInContext(readFileSync(resolve(__dirname,"../src/frontend/camera-preview.js"),"utf8"),context);
  const player=new context.CameraPreview({canvas,onError:e=>errors.push(e),onFrame:()=>shown.push(true)});
  const session={url:"ws://127.0.0.1:31000/"+"a".repeat(64),format:"hevc-annexb-v1",codec:"hev1.1.6.L93.B0"};
  const picture=(timestamp,key,tracking=null)=>{sockets[0].message(JSON.stringify({type:"frame",timestamp,key,tracking}));sockets[0].message(new ArrayBuffer(8));};
  return {context,player,session,canvas,sockets,workers,decoders,drawings,errors,shown,picture};
}

test("browser preview accepts only session-specific loopback connections",async()=>{
  for(const url of ["ws://192.0.2.1:31000/"+"a".repeat(64),"https://localhost:31000/token", "ws://user@localhost:31000/"+"a".repeat(64)]){
    const h=previewHarness();await assert.rejects(()=>h.player.start({...h.session,url}),/invalid local/);h.player.close();assert.equal(h.sockets.length,0);
  }
});

test("browser preview waits for keyframe and draws only its matching tracking box",async()=>{
  const h=previewHarness();await h.player.start(h.session);
  h.picture(1000,false);assert.equal(h.decoders[0].chunks.length,0);
  h.picture(41000,true,{x:.2,y:.1,width:.3,height:.6});h.picture(81000,false);
  assert.deepEqual(h.decoders[0].chunks.map(c=>c.timestamp),[0,40000]);
  h.decoders[0].output(0);assert.equal(h.drawings.filter(Array.isArray).length,1);
  h.decoders[0].output(40000);assert.equal(h.drawings.filter(Array.isArray).length,1);
  assert.equal(h.shown.length,2);assert.equal(h.canvas.width,64);h.player.close();
});

test("browser preview bounds WASM queue and resets references before resuming",async()=>{
  const h=previewHarness(false);await h.player.start(h.session);
  h.picture(0,true);for(let n=1;n<=5;n++)h.picture(n*40000,false);
  const worker=h.workers[0];assert.equal(worker.messages.filter(m=>m.type==="decode").length,4);
  for(let n=0;n<4;n++)worker.output({type:"decoded",timestamp:n*40000});
  h.picture(240000,false);assert.equal(worker.messages.filter(m=>m.type==="decode").length,4);
  h.picture(280000,true);assert.equal(worker.messages.filter(m=>m.type==="reset").length,1);
  assert.equal(worker.messages.filter(m=>m.type==="decode").length,5);h.player.close();assert.equal(worker.closed,true);
});

test("browser preview falls back to WASM when native HEVC decoder errors",async()=>{
  const h=previewHarness();await h.player.start(h.session);h.picture(0,true);
  h.decoders[0].callbacks.error(new Error("codec unavailable"));await new Promise(r=>setImmediate(r));
  assert.equal(h.workers.length,1);h.picture(40000,false);h.picture(80000,true);
  assert.equal(h.workers[0].messages.filter(m=>m.type==="decode").length,1);assert.equal(h.errors.length,0);h.player.close();
});

test("browser preview connection failure cleans resources and reports once",async()=>{
  const h=previewHarness(false);await h.player.start(h.session);h.sockets[0].onerror();h.sockets[0].onclose();
  assert.equal(h.errors.length,1);assert.equal(h.player.closed,true);assert.equal(h.workers[0].closed,true);
});

test("browser preview close settles pending WASM decoder initialization",async()=>{
  const h=previewHarness(false,false);const starting=h.player.start(h.session);
  h.player.close();
  await assert.rejects(starting,/closed/i);
  assert.equal(h.workers[0].closed,true);
});

test("browser preview closes an unusable native decoder before WASM fallback",async()=>{
  const h=previewHarness(true,true,true);await h.player.start(h.session);
  assert.equal(h.decoders.length,1);assert.equal(h.decoders[0].closed,true);assert.equal(h.workers.length,1);
  h.player.close();
});

test("browser preview worker error before ready settles startup and cleans up",async()=>{
  const h=previewHarness(false,false);const starting=h.player.start(h.session);
  h.workers[0].output({type:"error",message:"WASM failed to initialize"});
  await assert.rejects(starting,/WASM failed to initialize/);
  assert.equal(h.errors.length,1);assert.equal(h.player.closed,true);assert.equal(h.workers[0].closed,true);
});

test("browser preview worker error after ready fails once and cleans up",async()=>{
  const h=previewHarness(false);await h.player.start(h.session);
  h.workers[0].output({type:"error",message:"WASM decode failed"});
  h.workers[0].output({type:"error",message:"second error"});
  assert.deepEqual(h.errors,["WASM decode failed"]);assert.equal(h.player.closed,true);assert.equal(h.workers[0].closed,true);
});
