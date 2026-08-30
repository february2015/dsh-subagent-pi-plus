import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

// tiny 1x1 red PNG
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
mkdirSync("/tmp/codex-proto-0829/img", { recursive: true });
writeFileSync("/tmp/codex-proto-0829/img/red.png", png);

const child = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "", id = 0;
const pending = new Map();
const notifs = [];

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
      if (msg.method === "turn/completed" && pending["__done"]) { }
    } else if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); }
    }
  }
});
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const waitForTurn = async (label, timeoutMs = 180000) => {
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  while (Date.now() < deadline) {
    const found = notifs.filter(n => n.startsWith("turn/completed"));
    if (found.length > seen.length) { seen.push(found.at(-1)); return found.at(-1); }
    await wait(400);
  }
  throw new Error(label + " TIMEOUT; notifs=" + JSON.stringify(notifs));
};

try {
  await send("initialize", { clientInfo: { name: "probe3", version: "0.0.1" }, capabilities: { experimentalApi: true, requestAttestation: false } });
  console.log("[ok] initialize experimentalApi:true");

  // (1) persistent thread
  const t = (await send("thread/start", { cwd: "/tmp", ephemeral: false })).thread;
  console.log("[ok] thread/start persistent id=" + t.id + " ephemeral=" + t.ephemeral);

  // (2) first turn: text + localImage
  const t1 = (await send("turn/start", { threadId: t.id, input: [
    { type: "text", text: "Reply with exactly: FIRST", text_elements: [] },
    { type: "localImage", path: "/tmp/codex-proto-0829/img/red.png" },
  ] })).turn;
  console.log("[ok] turn/start(id=" + t1.id + ") with localImage accepted, status=" + t1.status);

  // (3) queue add while active
  try {
    const q1 = await send("thread/queue/add", { threadId: t.id, input: [{ type: "text", text: "queued ONE", text_elements: [] }], clientUserMessageId: "probe-q-1" });
    console.log("[ok] thread/queue/add -> " + JSON.stringify(q1.queued_submission?.id));
  } catch (e) { console.log("[FAIL] thread/queue/add: " + e.message); }
  try {
    const q2 = await send("thread/queue/add", { threadId: t.id, input: [{ type: "text", text: "queued TWO", text_elements: [] }], clientUserMessageId: "probe-q-2" });
    console.log("[ok] thread/queue/add #2 -> " + JSON.stringify(q2.queued_submission?.id));
  } catch (e) { console.log("[FAIL] thread/queue/add #2: " + e.message); }

  // (4) wait first turn complete
  const c1 = await waitForTurn("first turn");
  console.log("[ok] first turn completed: " + c1);

  // (5) queue/list
  const ql = await send("thread/queue/list", { threadId: t.id });
  console.log("[ok] thread/queue/list count=" + ql.data?.length + " ids=" + JSON.stringify(ql.data?.map(x => x.id)));

  // (6) queue/start -> processes one queued submission (FIFO)
  const st = await send("thread/queue/start", { threadId: t.id });
  console.log("[ok] thread/queue/start -> turn id=" + st.turn?.id + " status=" + st.turn?.status);
  const c2 = await waitForTurn("queued turn");
  console.log("[ok] queued turn completed: " + c2);

  // (7) steer a running turn on persistent thread
  const t3 = (await send("turn/start", { threadId: t.id, input: [{ type: "text", text: "Reply with exactly: BETA", text_elements: [] }] })).turn;
  await wait(300);
  try {
    const s = await send("turn/steer", { threadId: t.id, expectedTurnId: t3.id, input: [{ type: "text", text: "Reply with exactly: STEERED", text_elements: [] }] });
    console.log("[ok] turn/steer on persistent thread -> turn_id=" + s.turn_id);
  } catch (e) { console.log("[FAIL] turn/steer: " + e.message); }
  const c3 = await waitForTurn("steered turn", 120000);
  console.log("[ok] steered turn completed: " + c3);

  // (8) verify persistence on disk
  console.log("[info] threadId=" + t.id);
  console.log("[notifications] " + JSON.stringify(notifs));
} catch (e) {
  console.log("[FATAL] " + e.message);
  console.log("[notifications] " + JSON.stringify(notifs));
} finally {
  child.kill("SIGTERM"); setTimeout(() => process.exit(), 500);
}
