"""翻棋服务。只监听 127.0.0.1，数据库是 demo/data/fanqi.db。联机房间在内存里。"""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent
DEFAULT_PORT = 8787
NAME_RE = re.compile(r"^[A-Za-z0-9_\u4e00-\u9fff]{2,16}$")
MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".svg": "image/svg+xml",
    ".png": "image/png",
}
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
ROOMS = {}
ROOMS_LOCK = threading.Lock()


class Room:
    def __init__(self, code, seed):
        self.code = code
        self.seed = seed
        self.turn = "red"
        self.clients = {}
        self.lock = threading.Lock()


def normalize_code(value):
    if not isinstance(value, str):
        return ""
    code = value.strip().upper()
    if len(code) != 4 or any(ch not in ROOM_ALPHABET for ch in code):
        return ""
    return code


def new_room_code():
    for _ in range(30):
        code = "".join(ROOM_ALPHABET[secrets.randbelow(len(ROOM_ALPHABET))] for _ in range(4))
        if code not in ROOMS:
            return code
    raise RuntimeError("no room code")


def board_coord(value, limit):
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 0 or value > limit:
        return None
    return value


def init_db(db_path):
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          salt TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS games (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL,
          game_id TEXT NOT NULL,
          played_at INTEGER NOT NULL,
          winner TEXT,
          result TEXT,
          moves INTEGER NOT NULL,
          specials TEXT,
          UNIQUE (user_id, game_id)
        );
        """
    )
    conn.commit()
    conn.close()


def connect(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def hash_password(password, salt):
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=16384,
        r=8,
        p=1,
        dklen=32,
    )
    return digest.hex()


def session_cookie(token, max_age):
    return "fanqi_session=%s; HttpOnly; SameSite=Lax; Path=/; Max-Age=%s" % (
        token,
        max_age,
    )


def make_handler(db_path):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            return

        def do_GET(self):
            self.route()

        def do_POST(self):
            self.route()

        def do_PUT(self):
            self.route()

        def do_DELETE(self):
            self.route()

        def route(self):
            path = unquote(self.path.split("?", 1)[0])
            if path == "/ws":
                self.handle_ws()
                return
            try:
                if path.startswith("/api/"):
                    self.handle_api(path)
                else:
                    self.serve_static(path)
            except (json.JSONDecodeError, ValueError, UnicodeError):
                if not self.wfile.closed:
                    self.send_json(400, {"error": "请求无法处理"})

        def handle_ws(self):
            self.close_connection = True
            if self.headers.get("Upgrade", "").lower() != "websocket":
                self.send_error(400)
                return
            key = self.headers.get("Sec-WebSocket-Key", "")
            if not key:
                self.send_error(400)
                return
            accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")
            self.send_response(101, "Switching Protocols")
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            self.wfile.flush()
            self.connection.settimeout(None)
            self.ws_lock = threading.Lock()
            self.ws_room = None
            self.ws_role = None
            try:
                self.ws_loop()
            except OSError:
                return
            finally:
                self.ws_leave()

        def ws_loop(self):
            while True:
                frame = self.ws_read_frame()
                if frame is None:
                    break
                opcode, payload = frame
                if opcode == 8:
                    self.ws_frame(8, payload[:2] if payload else b"")
                    break
                if opcode == 9:
                    self.ws_frame(10, payload)
                    continue
                if opcode != 1:
                    continue
                try:
                    msg = json.loads(payload.decode("utf-8"))
                except (UnicodeError, json.JSONDecodeError):
                    self.ws_send({"type": "error", "error": "消息无法识别"})
                    continue
                if not isinstance(msg, dict):
                    self.ws_send({"type": "error", "error": "消息无法识别"})
                    continue
                self.ws_on_message(msg)

        def ws_on_message(self, msg):
            kind = msg.get("type")
            if kind == "create":
                self.ws_create(msg)
            elif kind == "join":
                self.ws_join(msg)
            elif kind == "move":
                self.ws_move(msg)
            elif kind == "undo":
                self.ws_undo()
            elif kind == "resign":
                self.ws_resign()
            elif kind == "restart":
                self.ws_restart()
            elif kind == "chat":
                self.ws_chat(msg)
            else:
                self.ws_send({"type": "error", "error": "消息无法识别"})

        def ws_create(self, msg):
            code = normalize_code(msg.get("code") if isinstance(msg, dict) else "")
            if not code:
                self.ws_send({"type": "error", "error": "房间号换成 4 个字母或数字，避开 0、1、I、O"})
                return
            self.ws_leave()
            verify = new_room_code()
            while verify == code:
                verify = new_room_code()
            seed = secrets.randbits(32)
            with ROOMS_LOCK:
                if code in ROOMS:
                    self.ws_send({"type": "error", "error": "这个房间号已经有人用了"})
                    return
                room = Room(code, seed)
                room.verify = verify
                room.clients["red"] = self
                ROOMS[code] = room
            self.ws_room = room
            self.ws_role = "red"
            self.ws_send({
                "type": "room",
                "code": code,
                "verify": verify,
                "role": "red",
                "seed": seed,
                "status": "waiting",
            })

        def ws_join(self, msg):
            if not isinstance(msg, dict):
                msg = {}
            code = normalize_code(msg.get("code"))
            verify = normalize_code(msg.get("verify"))
            if not code:
                self.ws_send({"type": "error", "error": "房间号换成 4 个字母或数字，避开 0、1、I、O"})
                return
            if not verify:
                self.ws_send({"type": "error", "error": "验证码填开房时显示的那一串"})
                return
            with ROOMS_LOCK:
                room = ROOMS.get(code)
                if room is None:
                    self.ws_send({"type": "error", "error": "没有这个房间"})
                    return
                if room.verify != verify:
                    self.ws_send({"type": "error", "error": "验证码不对"})
                    return
            self.ws_leave()
            with ROOMS_LOCK:
                room = ROOMS.get(code)
                if room is None or room.verify != verify:
                    self.ws_send({"type": "error", "error": "没有这个房间"})
                    return
                with room.lock:
                    host = room.clients.get("red")
                    if host is None or host is self or "black" in room.clients:
                        self.ws_send({"type": "error", "error": "房间已经满了"})
                        return
                    room.clients["black"] = self
                    room.turn = "red"
                    self.ws_room = room
                    self.ws_role = "black"
                    seed = room.seed
            start_red = {"type": "start", "code": code, "role": "red", "seed": seed}
            start_black = {"type": "start", "code": code, "role": "black", "seed": seed}
            host.ws_send(start_red)
            self.ws_send(start_black)

        def ws_move(self, msg):
            room = self.ws_room
            role = self.ws_role
            if room is None or role is None:
                self.ws_send({"type": "error", "error": "还没有进入房间"})
                return
            coords = (
                board_coord(msg.get("f"), 8),
                board_coord(msg.get("r"), 9),
                board_coord(msg.get("tf"), 8),
                board_coord(msg.get("tr"), 9),
            )
            if any(item is None for item in coords):
                self.ws_send({"type": "error", "error": "走法无效"})
                return
            with room.lock:
                other = "black" if role == "red" else "red"
                peer = room.clients.get(other)
                if peer is None or room.turn != role:
                    self.ws_send({"type": "error", "error": "还没轮到你"})
                    return
                room.turn = other
            peer.ws_send({"type": "move", "f": coords[0], "r": coords[1], "tf": coords[2], "tr": coords[3]})

        def ws_undo(self):
            room = self.ws_room
            role = self.ws_role
            if room is None or role is None:
                self.ws_send({"type": "error", "error": "还没有进入房间"})
                return
            other = "black" if role == "red" else "red"
            with room.lock:
                peer = room.clients.get(other)
                if peer is None or room.turn != other:
                    self.ws_send({"type": "error", "error": "只能悔自己刚走的一步"})
                    return
                room.turn = role
            peer.ws_send({"type": "undo"})

        def ws_resign(self):
            room = self.ws_room
            role = self.ws_role
            if room is None or role is None:
                self.ws_send({"type": "error", "error": "还没有进入房间"})
                return
            other = "black" if role == "red" else "red"
            with room.lock:
                peer = room.clients.get(other)
                if peer is None or room.turn != role:
                    self.ws_send({"type": "error", "error": "还没轮到你"})
                    return
            peer.ws_send({"type": "resign", "role": role})

        def ws_chat(self, msg):
            room = self.ws_room
            role = self.ws_role
            if room is None or role is None:
                self.ws_send({"type": "error", "error": "还没有进入房间"})
                return
            text = msg.get("text")
            if not isinstance(text, str):
                return
            text = " ".join(text.split())
            if not text:
                return
            text = text[:80]
            name = msg.get("name")
            if not isinstance(name, str):
                name = ""
            name = " ".join(name.split())[:16]
            payload = {"type": "chat", "text": text, "name": name, "role": role}
            with room.lock:
                peers = [handler for handler in room.clients.values() if handler is not self]
            for peer in peers:
                peer.ws_send(payload)

        def ws_restart(self):
            room = self.ws_room
            role = self.ws_role
            if room is None or role is None:
                self.ws_send({"type": "error", "error": "还没有进入房间"})
                return
            seed = secrets.randbits(32)
            with room.lock:
                if len(room.clients) < 2:
                    self.ws_send({"type": "error", "error": "还没有对方"})
                    return
                room.seed = seed
                room.turn = "red"
                targets = [(name, handler) for name, handler in room.clients.items()]
                code = room.code
            for name, handler in targets:
                handler.ws_send({"type": "restart", "code": code, "role": name, "seed": seed})

        def ws_leave(self):
            room = self.ws_room
            role = self.ws_role
            if room is None:
                return
            self.ws_room = None
            self.ws_role = None
            peer = None
            with ROOMS_LOCK:
                with room.lock:
                    if room.clients.get(role) is self:
                        room.clients.pop(role, None)
                    others = [handler for handler in room.clients.values() if handler is not self]
                    peer = others[0] if others else None
                    if not room.clients and ROOMS.get(room.code) is room:
                        del ROOMS[room.code]
            if peer is not None:
                peer.ws_send({"type": "peer-left"})

        def ws_read_exact(self, size):
            buf = bytearray()
            while len(buf) < size:
                chunk = self.rfile.read(size - len(buf))
                if not chunk:
                    return None
                buf.extend(chunk)
            return bytes(buf)

        def ws_read_frame(self):
            head = self.ws_read_exact(2)
            if not head:
                return None
            opcode = head[0] & 0x0F
            masked = head[1] & 0x80
            length = head[1] & 0x7F
            if length == 126:
                extra = self.ws_read_exact(2)
                if not extra:
                    return None
                length = struct.unpack("!H", extra)[0]
            elif length == 127:
                extra = self.ws_read_exact(8)
                if not extra:
                    return None
                length = struct.unpack("!Q", extra)[0]
            if length > 65536:
                return None
            mask = b""
            if masked:
                mask = self.ws_read_exact(4)
                if not mask:
                    return None
            payload = b""
            if length:
                payload = self.ws_read_exact(length)
                if payload is None:
                    return None
                if masked:
                    payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
            return opcode, payload

        def ws_frame(self, opcode, payload):
            if isinstance(payload, str):
                payload = payload.encode("utf-8")
            size = len(payload)
            header = bytearray([0x80 | opcode])
            if size < 126:
                header.append(size)
            elif size < 65536:
                header.append(126)
                header.extend(struct.pack("!H", size))
            else:
                header.append(127)
                header.extend(struct.pack("!Q", size))
            with self.ws_lock:
                self.wfile.write(bytes(header) + payload)
                self.wfile.flush()

        def ws_send(self, obj):
            try:
                self.ws_frame(1, json.dumps(obj, ensure_ascii=False).encode("utf-8"))
            except (OSError, ValueError):
                return

        def read_json(self):
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length > 100000:
                raise ValueError("too large")
            raw = self.rfile.read(length) if length else b""
            if not raw:
                return {}
            data = json.loads(raw.decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError("not an object")
            return data

        def send_json(self, status, body, cookie=None):
            raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-cache")
            if cookie is not None:
                self.send_header("Set-Cookie", cookie)
            self.end_headers()
            self.wfile.write(raw)

        def token(self):
            raw = self.headers.get("Cookie", "")
            match = re.search(r"(?:^|;\s*)fanqi_session=([^;]+)", raw)
            return unquote(match.group(1)) if match else ""

        def user(self, conn):
            token = self.token()
            if not token:
                return None
            return conn.execute(
                """
                SELECT users.id AS id, users.username AS username
                FROM sessions JOIN users ON users.id = sessions.user_id
                WHERE sessions.token = ?
                """,
                (token,),
            ).fetchone()

        def handle_api(self, path):
            if self.command == "POST" and path == "/api/register":
                self.register()
                return
            if self.command == "POST" and path == "/api/login":
                self.login()
                return
            if self.command == "POST" and path == "/api/logout":
                self.logout()
                return
            if self.command == "GET" and path == "/api/me":
                self.me()
                return
            conn = connect(db_path)
            try:
                user = self.user(conn)
                if not user:
                    self.send_json(401, {"error": "还没有登录"})
                    return
                if self.command == "GET" and path == "/api/records":
                    self.records(conn, user)
                    return
                if self.command == "PUT" and path == "/api/records":
                    self.save_record(conn, user)
                    return
                match = re.fullmatch(r"/api/records/([^/]+)", path)
                if self.command == "DELETE" and match:
                    conn.execute(
                        "DELETE FROM games WHERE user_id = ? AND game_id = ?",
                        (user["id"], unquote(match.group(1))),
                    )
                    conn.commit()
                    self.send_json(200, {"ok": True})
                    return
                self.send_json(404, {"error": "没有这个接口"})
            finally:
                conn.close()

        def register(self):
            body = self.read_json()
            username = body.get("username")
            password = body.get("password")
            if not isinstance(username, str) or not NAME_RE.fullmatch(username):
                self.send_json(400, {"error": "账号用 2 到 16 位字母、数字或汉字"})
                return
            if not isinstance(password, str) or not 6 <= len(password) <= 64:
                self.send_json(400, {"error": "密码至少 6 位"})
                return
            conn = connect(db_path)
            try:
                exists = conn.execute(
                    "SELECT id FROM users WHERE username = ? COLLATE NOCASE",
                    (username,),
                ).fetchone()
                if exists:
                    self.send_json(409, {"error": "这个账号已经有人用了"})
                    return
                salt = os.urandom(16)
                digest = hash_password(password, salt)
                cur = conn.execute(
                    "INSERT INTO users (username, salt, password_hash, created_at) VALUES (?, ?, ?, ?)",
                    (username, salt.hex(), digest, int(time.time() * 1000)),
                )
                token = os.urandom(24).hex()
                conn.execute(
                    "INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)",
                    (token, cur.lastrowid, int(time.time() * 1000)),
                )
                conn.commit()
            finally:
                conn.close()
            self.send_json(200, {"username": username}, session_cookie(token, 60 * 60 * 24 * 30))

        def login(self):
            body = self.read_json()
            username = body.get("username") if isinstance(body.get("username"), str) else ""
            password = body.get("password") if isinstance(body.get("password"), str) else ""
            conn = connect(db_path)
            try:
                row = conn.execute(
                    "SELECT id, username, salt, password_hash FROM users WHERE username = ? COLLATE NOCASE",
                    (username,),
                ).fetchone()
                if not row:
                    self.send_json(401, {"error": "账号或密码不对"})
                    return
                digest = hash_password(password, bytes.fromhex(row["salt"]))
                if not hmac.compare_digest(digest, row["password_hash"]):
                    self.send_json(401, {"error": "账号或密码不对"})
                    return
                token = os.urandom(24).hex()
                conn.execute("DELETE FROM sessions WHERE user_id = ?", (row["id"],))
                conn.execute(
                    "INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)",
                    (token, row["id"], int(time.time() * 1000)),
                )
                conn.commit()
                name = row["username"]
            finally:
                conn.close()
            self.send_json(200, {"username": name}, session_cookie(token, 60 * 60 * 24 * 30))

        def logout(self):
            token = self.token()
            if token:
                conn = connect(db_path)
                try:
                    conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
                    conn.commit()
                finally:
                    conn.close()
            self.send_json(200, {"ok": True}, session_cookie("", 0))

        def me(self):
            conn = connect(db_path)
            try:
                user = self.user(conn)
            finally:
                conn.close()
            if not user:
                self.send_json(401, {"error": "还没有登录"})
                return
            self.send_json(200, {"username": user["username"]})

        def records(self, conn, user):
            rows = conn.execute(
                """
                SELECT game_id, played_at, winner, result, moves, specials
                FROM games WHERE user_id = ? ORDER BY played_at DESC LIMIT 20
                """,
                (user["id"],),
            ).fetchall()
            self.send_json(200, {"records": [public_record(row) for row in rows]})

        def save_record(self, conn, user):
            body = self.read_json()
            game_id = body.get("gameId")
            if not isinstance(game_id, str) or not game_id:
                self.send_json(400, {"error": "缺少对局"})
                return
            played_at = body.get("at")
            played_at = int(played_at) if isinstance(played_at, (int, float)) else int(time.time() * 1000)
            moves = body.get("moves")
            moves = int(moves) if isinstance(moves, (int, float)) else 0
            conn.execute(
                """
                INSERT INTO games (user_id, game_id, played_at, winner, result, moves, specials)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (user_id, game_id) DO UPDATE SET
                  played_at = excluded.played_at,
                  winner = excluded.winner,
                  result = excluded.result,
                  moves = excluded.moves,
                  specials = excluded.specials
                """,
                (
                    user["id"],
                    game_id,
                    played_at,
                    body.get("winner") or None,
                    body.get("result") or "",
                    moves,
                    json.dumps(body.get("specials") or {}, ensure_ascii=False),
                ),
            )
            conn.commit()
            self.send_json(200, {"ok": True})

        def serve_static(self, path):
            file = safe_file(path)
            if not file:
                self.send_error(404)
                return
            data = file.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", MIME.get(file.suffix.lower(), "application/octet-stream"))
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)

    return Handler


def public_record(row):
    try:
        specials = json.loads(row["specials"] or "{}")
    except json.JSONDecodeError:
        specials = {}
    return {
        "gameId": row["game_id"],
        "at": row["played_at"],
        "winner": row["winner"],
        "result": row["result"],
        "moves": row["moves"],
        "specials": specials,
    }


def safe_file(pathname):
    rel = unquote(pathname.split("?", 1)[0])
    if rel == "/":
        rel = "/index.html"
    rel = rel.lstrip("/")
    if not rel or rel.startswith("data/") or rel.startswith("data\\") or "\0" in rel:
        return None
    file = (ROOT / rel).resolve()
    if file != ROOT and ROOT not in file.parents:
        return None
    if not file.is_file():
        return None
    return file


def serve(port=DEFAULT_PORT, db_path=None):
    db_path = db_path or str(ROOT / "data" / "fanqi.db")
    init_db(db_path)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(db_path))
    return httpd


if __name__ == "__main__":
    httpd = serve(int(os.environ.get("FANQI_PORT", DEFAULT_PORT)))
    print("翻棋 http://127.0.0.1:%s/" % httpd.server_address[1], flush=True)
    httpd.serve_forever()
