//! The fast lane for presence: cursors, views and selections go from one person's socket
//! straight to everyone else's outbound queue, without waiting in the document actor's
//! mailbox behind ops (each of which waits on Postgres) and without the actor's flush tick.
//!
//! The actor stays the owner of who is in the document: it adds a client here when its join
//! succeeds and takes it out when it leaves.  It also keeps each client's latest state (for
//! people who join later, for other replicas, and to notice someone who went quiet); this
//! lane only carries the live updates between the people on this replica.
//!
//! A client may send as fast as its pointer moves.  An update that comes less than
//! `MIN_GAP` after the last one forwarded from the same client is held, and the actor's tick
//! sends the newest held one, so a fast sender costs at most one fan-out per `MIN_GAP` and
//! the place the pointer stopped always arrives.  Forwarding and holding happen under one
//! lock, so a held (older) state can never overtake a newer one on its way out.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::sync::mpsc;
use uuid::Uuid;

/// The shortest time between two forwarded updates of one client.  Editors send at most
/// every 14 ms, so this only catches two that the network bunched together (and anyone
/// sending faster than they should).
pub const MIN_GAP: Duration = Duration::from_millis(4);

struct LanePeer {
    tx: mpsc::Sender<String>,
    /// The peer's `user` object, already serialized.
    user: String,
    last_forward: Option<Instant>,
    /// A state that came too soon after the last forward, already serialized.
    held: Option<String>,
}

#[derive(Default)]
pub struct PresenceLane {
    peers: Mutex<HashMap<String, LanePeer>>,
}

impl PresenceLane {
    pub fn join(&self, client_id: &str, tx: mpsc::Sender<String>, user: String) {
        self.peers.lock().unwrap().insert(
            client_id.to_string(),
            LanePeer { tx, user, last_forward: None, held: None },
        );
    }

    /// Take a client out; only the connection that joined (`tx`) can, so a late leave from
    /// a dead socket does not remove its replacement.
    pub fn leave(&self, client_id: &str, tx: &mpsc::Sender<String>) {
        let mut peers = self.peers.lock().unwrap();
        if peers.get(client_id).is_some_and(|p| p.tx.same_channel(tx)) {
            peers.remove(client_id);
        }
    }

    /// Take a client out whatever connection it is on (the actor dropped it).
    pub fn remove(&self, client_id: &str) {
        self.peers.lock().unwrap().remove(client_id);
    }

    /// A client's new state (serialized).  Sent to everyone else now, or held for the next
    /// `flush` when it follows the last one too closely.  Returns false when the client is
    /// not (yet) in the lane: the actor's own path then has to deliver it.
    pub fn update(&self, doc_id: Uuid, client_id: &str, state: String) -> bool {
        let mut peers = self.peers.lock().unwrap();
        let Some(me) = peers.get_mut(client_id) else { return false };
        let now = Instant::now();
        if me.last_forward.is_some_and(|t| now.duration_since(t) < MIN_GAP) {
            me.held = Some(state);
            return true;
        }
        me.last_forward = Some(now);
        me.held = None;
        let msg = message(doc_id, &[(client_id, &me.user, &state)]);
        fan_out(&mut peers, Some(client_id), &msg);
        true
    }

    /// Send the held states that are due, in one message.  Called on the actor's tick.
    pub fn flush(&self, doc_id: Uuid) {
        let mut peers = self.peers.lock().unwrap();
        let now = Instant::now();
        let mut due: Vec<(String, String, String)> = Vec::new();
        for (id, p) in peers.iter_mut() {
            if p.held.is_some() && p.last_forward.is_none_or(|t| now.duration_since(t) >= MIN_GAP) {
                p.last_forward = Some(now);
                due.push((id.clone(), p.user.clone(), p.held.take().unwrap()));
            }
        }
        match due.len() {
            0 => {}
            // one sender: everyone but them
            1 => {
                let (id, user, state) = &due[0];
                let msg = message(doc_id, &[(id, user, state)]);
                fan_out(&mut peers, Some(id), &msg);
            }
            // several: clients skip their own entry (as for the actor's batched presence)
            _ => {
                let parts: Vec<(&str, &str, &str)> =
                    due.iter().map(|(a, b, c)| (a.as_str(), b.as_str(), c.as_str())).collect();
                let msg = message(doc_id, &parts);
                fan_out(&mut peers, None, &msg);
            }
        }
    }
}

/// `{"type":"presence","docId":…,"peers":{id:{"user":…,"state":…},…}}`, the shape the
/// actor sends, put together from pieces that are already JSON.
fn message(doc_id: Uuid, entries: &[(&str, &str, &str)]) -> String {
    let mut s = String::with_capacity(96 + entries.iter().map(|e| e.0.len() + e.1.len() + e.2.len() + 24).sum::<usize>());
    s.push_str(r#"{"type":"presence","docId":""#);
    s.push_str(&doc_id.to_string());
    s.push_str(r#"","peers":{"#);
    for (i, (id, user, state)) in entries.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&serde_json::Value::String((*id).to_string()).to_string());
        s.push_str(r#":{"user":"#);
        s.push_str(user);
        s.push_str(r#","state":"#);
        s.push_str(state);
        s.push('}');
    }
    s.push_str("}}");
    s
}

/// try_send to everyone but `skip`.  Presence is superseded by the next update, so a full
/// queue just misses this one (no resync), and a closed one is dropped from the lane (the
/// actor announces the leave when it notices).
fn fan_out(peers: &mut HashMap<String, LanePeer>, skip: Option<&str>, msg: &str) {
    let mut closed = Vec::new();
    for (id, p) in peers.iter() {
        if Some(id.as_str()) == skip {
            continue;
        }
        if let Err(mpsc::error::TrySendError::Closed(_)) = p.tx.try_send(msg.to_string()) {
            closed.push(id.clone());
        }
    }
    for id in closed {
        peers.remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(lane: &PresenceLane, id: &str) -> mpsc::Receiver<String> {
        let (tx, rx) = mpsc::channel(64);
        lane.join(id, tx, format!(r#"{{"clientId":"{id}"}}"#));
        rx
    }

    #[test]
    fn forwards_at_once_holds_bursts_and_flushes_the_last() {
        let lane = PresenceLane::default();
        let doc = Uuid::nil();
        let mut a = peer(&lane, "a");
        let mut b = peer(&lane, "b");
        assert!(lane.update(doc, "a", r#"{"cursor":[1,2]}"#.into()));
        let m: serde_json::Value = serde_json::from_str(&b.try_recv().unwrap()).unwrap();
        assert_eq!(m["type"], "presence");
        assert_eq!(m["peers"]["a"]["state"]["cursor"][0], 1);
        assert_eq!(m["peers"]["a"]["user"]["clientId"], "a");
        assert!(a.try_recv().is_err(), "the sender does not get its own update");
        // too soon: held, and only the newest survives
        assert!(lane.update(doc, "a", r#"{"cursor":[2,2]}"#.into()));
        assert!(lane.update(doc, "a", r#"{"cursor":[3,2]}"#.into()));
        assert!(b.try_recv().is_err());
        std::thread::sleep(MIN_GAP);
        lane.flush(doc);
        let m: serde_json::Value = serde_json::from_str(&b.try_recv().unwrap()).unwrap();
        assert_eq!(m["peers"]["a"]["state"]["cursor"][0], 3);
        lane.flush(doc);
        assert!(b.try_recv().is_err(), "nothing held, nothing sent");
    }

    #[test]
    fn unknown_client_is_left_to_the_actor_and_leave_needs_the_same_socket() {
        let lane = PresenceLane::default();
        assert!(!lane.update(Uuid::nil(), "x", "{}".into()));
        let _a = peer(&lane, "a");
        let (other, _rx) = mpsc::channel(1);
        lane.leave("a", &other);
        assert!(lane.update(Uuid::nil(), "a", "{}".into()), "a stranger's leave is ignored");
        lane.remove("a");
        assert!(!lane.update(Uuid::nil(), "a", "{}".into()));
    }
}
