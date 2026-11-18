// Chat.tsx — the project chat (web/domains/pcb/editor/chat.ts): who is here, the conversation, and the composer.
// A message can carry a link to a part, a net or a spot on any document of the project; clicking it brings the
// place into view.  Enter sends, Shift+Enter starts a new line; the pin button links the selection (or the view).
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { dispatch, useApp, type ChatLink, type ChatMessage } from "../../store";
import { cx } from "../../util";

function when(iso: string): string {
  const d = new Date(iso), now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
function linkText(l: ChatLink): string {
  const where = l.kind === "net" ? `Net ${l.label || l.id}` : l.kind === "spot" ? "A spot" : l.label || "Item";
  const file = (l.path || "").split("/").pop() || "";
  return file ? `${where} · ${file}` : where;
}
/** A person's colour, steady across sessions (their peer colour changes each visit). */
function hue(login: string): string {
  let h = 0; for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) % 360;
  return `hsl(${h} 55% 45%)`;
}
function Avatar({ m }: { m: ChatMessage }) {
  if (m.authorAvatar) return <img className="chat-av" src={m.authorAvatar} alt="" />;
  return <span className="chat-av" style={{ background: hue(m.authorLogin) }}>{(m.authorName || m.authorLogin).charAt(0).toUpperCase()}</span>;
}
/** Bare web addresses in a message become links (nothing else is markup: the text is shown as typed). */
function Body({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"]+)/g);
  return <div className="chat-text">{parts.map((p, i) => (i % 2 ? <a key={i} href={p} target="_blank" rel="noopener noreferrer">{p}</a> : p))}</div>;
}

function Message({ m, head, mine, owner, unreadMark }: { m: ChatMessage; head: boolean; mine: boolean; owner: boolean; unreadMark: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.body);
  const save = () => { const t = draft.trim(); if (t && t !== m.body) dispatch({ type: "chat", cmd: "edit", id: m.id, body: t }); setEditing(false); };
  return (
    <>
      {unreadMark ? <div className="chat-new" data-chat-new=""><span>New</span></div> : null}
      <div className={cx("chat-msg", head && "head", m.pending && "pending", mine && "mine")} data-chat-msg={m.id}>
        {head ? <Avatar m={m} /> : <span className="chat-av-gap" />}
        <div className="chat-main">
          {head ? <div className="chat-meta"><b>{m.authorName || m.authorLogin}</b><span title={new Date(m.createdAt).toLocaleString()}>{when(m.createdAt)}</span></div> : null}
          {editing ? (
            <div className="chat-edit">
              <textarea className="input" value={draft} rows={2} autoFocus onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); } if (e.key === "Escape") { e.preventDefault(); setEditing(false); setDraft(m.body); } }} />
              <div className="row"><button type="button" className="btn sm primary" onClick={save}>Save</button><button type="button" className="btn sm" onClick={() => { setEditing(false); setDraft(m.body); }}>Cancel</button></div>
            </div>
          ) : <Body text={m.body} />}
          {m.editedAt && !editing ? <span className="chat-edited">(edited)</span> : null}
          {m.link ? <button type="button" className={cx("chat-link", m.link.kind)} data-chat-link="" title="Show it" onClick={() => dispatch({ type: "chat", cmd: "goto", link: m.link! })}><i />{linkText(m.link)}</button> : null}
        </div>
        {!m.pending && !editing && (mine || owner) ? (
          <span className="chat-acts">
            {mine ? <button type="button" title="Edit" data-chat-edit="" onClick={() => { setDraft(m.body); setEditing(true); }}>Edit</button> : null}
            <button type="button" title="Delete" data-chat-delete="" onClick={() => dispatch({ type: "chat", cmd: "delete", id: m.id })}>Delete</button>
          </span>
        ) : null}
      </div>
    </>
  );
}

export function ChatPane() {
  const chat = useApp((s) => s.chat);
  const me = useApp((s) => s.me);
  const owner = useApp((s) => !!(s.me && s.project && s.project.ownerId === s.me.id));
  const canWrite = useApp((s) => !!s.canComment);
  const peers = useApp((s) => s.peers.list);
  const [text, setText] = useState("");
  const [attach, setAttach] = useState(false);
  const list = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const msgs = chat ? chat.messages : [];
  // where the "New" rule goes: the first message from someone else after what was read when the pane opened
  // (messages that arrive while the pane is on screen are read as they come: no rule for them)
  const [readAt, setReadAt] = useState<[number, number] | null>(null);
  useEffect(() => { if (chat && readAt === null && !chat.loading && chat.projectId) setReadAt([chat.lastReadId, chat.messages.reduce((a, m) => Math.max(a, m.id), 0)]); }, [chat, readAt]);
  useEffect(() => { setReadAt(null); }, [chat && chat.projectId]);
  const firstNew = readAt !== null ? msgs.find((m) => m.id > readAt[0] && m.id <= readAt[1] && (!me || m.authorId !== me.id)) : undefined;

  // keep the newest message in view while the reader is at the bottom
  useLayoutEffect(() => { const el = list.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [msgs.length, msgs[msgs.length - 1]?.id]);
  useEffect(() => { if (msgs.length) dispatch({ type: "chat", cmd: "read" }); }, [msgs.length]);
  // the pane shown, resized or its dock rearranged: still at the newest message
  useEffect(() => {
    const el = list.current; if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el); return () => ro.disconnect();
  }, []);

  const send = () => { const t = text.trim(); if (!t) return; stick.current = true; dispatch({ type: "chat", cmd: "send", body: t }); setText(""); setAttach(false); };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();   // the editor's hotkeys stay out of the composer
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };
  const toggleAttach = () => { const on = !attach; setAttach(on); dispatch({ type: "chat", cmd: "attach", on }); };

  return (
    <div className="kbody chat-pane flex-auto min-h-0 flex flex-col bg-paper text-sm" id="chatPane">
      <div className="chat-here" title="People in this document now">
        {me ? <span className="chat-dot" style={{ background: "var(--mark)" }} title={`${me.name || me.login} (you)`} /> : null}
        {peers.map((p) => <span key={p.cid} className="chat-dot" style={{ background: p.color }} title={p.name} />)}
        <span className="chat-here-n">{peers.length ? `${peers.length + (me ? 1 : 0)} here now` : "Only you here now"}</span>
        <span className="flex-1" />
        <span className="chat-tip" title="Alt+M at the pointer: say something there, live, like Figma's cursor chat">Alt+M at cursor</span>
      </div>
      <div className="chat-list" ref={list} id="chatList" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {chat && chat.more ? <button type="button" className="btn sm chat-older" disabled={chat.loading} onClick={() => dispatch({ type: "chat", cmd: "older" })}>Show earlier messages</button> : null}
        {!chat || (chat.loading && !msgs.length) ? <p className="note">Loading the chat…</p> : null}
        {chat && chat.error ? <p className="note">{chat.error}</p> : null}
        {chat && !chat.loading && !chat.error && !msgs.length ? <p className="note">No messages yet. Everyone working on this project sees what you write here, live. Link the selection with the pin to point at a part, a net or a spot.</p> : null}
        {msgs.map((m, i) => {
          const prev = msgs[i - 1];
          const head = !prev || prev.authorId !== m.authorId || new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > 5 * 60000 || m === firstNew;
          return <Message key={m.id} m={m} head={head} mine={!!me && m.authorId === me.id} owner={owner} unreadMark={m === firstNew} />;
        })}
      </div>
      <div className="chat-compose">
        {attach && chat && chat.link ? <div className="chat-attached"><span className={cx("chat-link", chat.link.kind)}><i />{linkText(chat.link)}</span><button type="button" className="kx" title="Remove the link" onClick={toggleAttach}>×</button></div> : null}
        <div className="chat-row">
          <button type="button" className={cx("chat-pin", attach && "on")} aria-pressed={attach} disabled={!canWrite} title="Link the selection (or the place you are looking at) to the message" data-chat-attach="" onClick={toggleAttach}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 14.5s-4.5-4.6-4.5-8a4.5 4.5 0 0 1 9 0c0 3.4-4.5 8-4.5 8z" /><circle cx="8" cy="6.5" r="1.6" /></svg>
          </button>
          <textarea id="chatText" className="input chat-input" rows={1} value={text} disabled={!canWrite} maxLength={4000}
            placeholder={canWrite ? "Message the project" : me ? "You can read this chat but not write in it" : "Sign in to chat"}
            onChange={(e) => setText(e.target.value)} onKeyDown={key} onFocus={() => dispatch({ type: "chat", cmd: "read" })} />
          <button type="button" className="btn sm primary" id="chatSend" disabled={!canWrite || !text.trim()} onClick={send}>Send</button>
        </div>
      </div>
    </div>
  );
}
