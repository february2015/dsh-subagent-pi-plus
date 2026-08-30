import { spawn } from "node:child_process";
const child = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "", id = 0;
const pending = new Map();
const notifs = [];
let turn = null, thread = null, done = null;

function send(method, params) {
  const msg = { jsonrpc: "2.0", id: ++id, method, params };
  child.stdin.write(JSON.stringify(msg) + "\n");
  return new Promise((res, rej) => pending.set(id, { res, rej, method }));
}
child.stdout.on("data", (chunk) => {
  buf += chunk; let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method) {
      notifs.push(msg.method + ":" + (msg.params?.turn?.status ?? msg.params?.item?.type ?? ""));
      if (msg.method === "turn/completed") { if (done) done.resolve(msg); }
    } else if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); }
    }
  }
});
const wait = (ms) => new Promise(r => setTimeout(r, ms));
try {
  await send("initialize", { clientInfo: { name: "probe2", version: "0.0.1" }, capabilities: { experimentalApi: true, requestAttestation: false } });
  console.log("[ok] initialize with experimentalApi:true");
  const t = (await send("thread/start", { cwd: "/tmp", ephemeral: true })).thread;
  thread = t; console.log("[ok] thread/start id=" + t.id);
  turn = (await send("turn/start", { threadId: t.id, input: [{ type: "text", text: "Reply with exactly: OK", text_elements: [] }] })).turn;
  console.log("[ok] turn/start id=" + turn.id + " status=" + turn.status);
  await wait(500);
  try {
    const q = await send("thread/queue/add", { threadId: t.id, input: [{ type: "text", text: "queued message 1", text_elements: [] }], clientUserMessageId: "probe-1" });
    console.log("[ok] thread/queue/add -> queued id=" + q.queued_submission?.id);
  } catch (e) { console.log("[FAIL] thread/queue/add: " + e.message); }
  try {
    const ql = await send("thread/queue/list", { threadId: t.id });
    console.log("[ok] thread/queue/list count=" + ql.data?.length);
  } catch (e) { console.log("[FAIL] thread/queue/list: " + e.message); }
  await wait(300);
  try {
    const s = await send("turn/steer", { threadId: t.id, expectedTurnId: turn.id, input: [{ type: "text", text: "Actually reply with exactly: STEERED", text_elements: [] }] });
    console.log("[ok] turn/steer -> turn_id=" + s.turn_id);
  } catch (e) { console.log("[FAIL] turn/steer: " + e.message); }
  console.log("[wait] waiting for turn completion / interrupt ...");
  const deadline = Date.now() + 150000;
  let completed = null;
  while (Date.now() < deadline) {
    if (notifs.some(n => n.startsWith("turn/completed"))) { completed = notifs.filter(n=>n.startsWith("turn/completed")).at(-1); break; }
    await wait(400);
  }
  console.log("[result] completed=" + completed ?? "TIMEOUT");
  try { await send("turn/interrupt", { threadId: t.id, turnId: turn.id }); console.log("[ok] turn/interrupt"); } catch (e) { console.log("[FAIL] turn/interrupt: " + e.message); }
  console.log("[notifications] " + JSON.stringify(notifs));
} catch (e) {
  console.log("[FATAL] " + e.message);
} finally {
  child.kill("SIGTERM"); setTimeout(() => process.exit(), 500);
}
