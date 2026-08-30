import { spawn } from "node:child_process";
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
      notifs.push(msg.method + ":" + (msg.params?.turn?.status ?? msg.params?.item?.type ?? msg.params?.queued_submission?.id ?? ""));
    } else if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); }
    }
  }
});
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const completedCount = () => notifs.filter(n => n.startsWith("turn/completed")).length;
const waitForTurn = async (label, target, timeoutMs = 180000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (completedCount() >= target) return completedCount();
    await wait(400);
  }
  throw new Error(label + " TIMEOUT; completed=" + completedCount() + " notifs=" + JSON.stringify(notifs));
};
try {
  await send("initialize", { clientInfo: { name: "probe4", version: "0.0.1" }, capabilities: { experimentalApi: true, requestAttestation: false } });
  const t = (await send("thread/start", { cwd: "/tmp", ephemeral: false })).thread;
  console.log("[ok] persistent thread " + t.id);

  // idle queue: add two items before any turn
  const r1 = await send("thread/queue/add", { threadId: t.id, input: [{ type: "text", text: "Reply with exactly: QUEUED_A", text_elements: [] }], clientUserMessageId: "q-a" });
  const r2 = await send("thread/queue/add", { threadId: t.id, input: [{ type: "text", text: "Reply with exactly: QUEUED_B", text_elements: [] }], clientUserMessageId: "q-b" });
  console.log("[ok] queue/add x2 idle -> ids=" + JSON.stringify([r1.queuedSubmission?.id, r2.queuedSubmission?.id]));

  const ql0 = await send("thread/queue/list", { threadId: t.id });
  console.log("[ok] queue/list count=" + ql0.data?.length);

  // start queued turn explicitly (FIFO)
  const st = await send("thread/queue/start", { threadId: t.id });
  console.log("[ok] thread/queue/start -> turn " + st.turn?.id + " status=" + st.turn?.status + " remaining=" + JSON.stringify((await send("thread/queue/list", { threadId: t.id })).data?.length));
  await waitForTurn("queued-A", 1);

  // auto-drain: second item should auto-start
  await waitForTurn("queued-B auto-drain", 2);
  const ql1 = await send("thread/queue/list", { threadId: t.id });
  console.log("[ok] auto-drain confirmed, queue remaining=" + ql1.data?.length);

  // queue/update + delete on a fresh idle item
  await send("thread/queue/add", { threadId: t.id, input: [{ type: "text", text: "to-edit", text_elements: [] }], clientUserMessageId: "q-c" });
  const ql2 = await send("thread/queue/list", { threadId: t.id });
  const qid = ql2.data[0].id;
  const up = await send("thread/queue/update", { threadId: t.id, queuedSubmissionId: qid, input: [{ type: "text", text: "edited", text_elements: [] }] });
  console.log("[ok] queue/update -> id=" + up.queuedSubmission?.id);
  const del = await send("thread/queue/delete", { threadId: t.id, queuedSubmissionId: qid });
  console.log("[ok] queue/delete -> deleted=" + del.deleted);
  console.log("[final] threadId=" + t.id + " notifs=" + JSON.stringify(notifs.filter(n => n.startsWith("thread/queue") || n.startsWith("turn/"))));
} catch (e) {
  console.log("[FATAL] " + e.message);
  console.log("[notifs] " + JSON.stringify(notifs));
} finally {
  child.kill("SIGTERM"); setTimeout(() => process.exit(), 500);
}
