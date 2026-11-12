import base64
import hashlib
import json
import os
import socket
import struct
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class Client:
    def __init__(self, port):
        self.sock = socket.create_connection(("127.0.0.1", port))
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            "GET /ws HTTP/1.1\r\n"
            "Host: 127.0.0.1\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n" % key
        )
        self.sock.sendall(request.encode("ascii"))
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("handshake closed")
            data += chunk
        head, self.pending = data.split(b"\r\n\r\n", 1)
        text = head.decode("ascii", "replace")
        if " 101 " not in text:
            raise RuntimeError(text)
        accept = base64.b64encode(hashlib.sha1((key + GUID).encode("ascii")).digest()).decode("ascii")
        if accept not in text:
            raise RuntimeError("bad accept")

    def send(self, obj):
        payload = json.dumps(obj).encode("utf-8")
        mask = os.urandom(4)
        frame = bytes([0x81, 0x80 | len(payload)]) + mask
        frame += bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.sock.sendall(frame)

    def recv(self):
        while True:
            frame = self._frame()
            if frame is None:
                raise RuntimeError("socket closed")
            opcode, payload = frame
            if opcode == 1:
                return json.loads(payload.decode("utf-8"))

    def _exact(self, size):
        buf = bytearray(self.pending)
        self.pending = b""
        while len(buf) < size:
            chunk = self.sock.recv(size - len(buf))
            if not chunk:
                return None
            buf.extend(chunk)
        extra = bytes(buf[size:])
        self.pending = extra
        return bytes(buf[:size])

    def _frame(self):
        head = self._exact(2)
        if not head:
            return None
        opcode = head[0] & 0x0F
        length = head[1] & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._exact(8))[0]
        payload = self._exact(length) if length else b""
        return opcode, payload

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def main():
    db_path = os.path.join(tempfile.gettempdir(), "fanqi-ws-%s.db" % os.getpid())
    httpd = server.serve(0, db_path)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    host = Client(port)
    guest = Client(port)
    try:
        host.send({"type": "create", "code": "ABCD"})
        room = host.recv()
        assert room["type"] == "room" and room["code"] == "ABCD" and room["role"] == "red", room
        assert len(room["verify"]) == 4 and room["verify"] != room["code"], room
        guest.send({"type": "join", "code": "ABCD", "verify": "WXYZ"})
        denied_verify = guest.recv()
        assert denied_verify["type"] == "error", denied_verify
        guest.send({"type": "join", "code": room["code"].lower(), "verify": room["verify"].lower()})
        started = [host.recv(), guest.recv()]
        by_role = {item["role"]: item for item in started}
        assert by_role["red"]["type"] == "start" and by_role["black"]["type"] == "start"
        assert by_role["red"]["seed"] == by_role["black"]["seed"] == room["seed"]
        host.send({"type": "move", "f": 0, "r": 1, "tf": 0, "tr": 2})
        moved = guest.recv()
        assert moved["type"] == "move" and moved["tr"] == 2, moved
        host.send({"type": "move", "f": 1, "r": 1, "tf": 1, "tr": 2})
        denied = host.recv()
        assert denied["type"] == "error", denied
        host.send({"type": "undo"})
        undone = guest.recv()
        assert undone["type"] == "undo", undone
        host.send({"type": "resign"})
        resigned = guest.recv()
        assert resigned["type"] == "resign" and resigned["role"] == "red", resigned
        guest.send({"type": "chat", "text": " 你好  ", "name": "黑棋手"})
        heard = host.recv()
        assert heard["type"] == "chat" and heard["text"] == "你好" and heard["role"] == "black", heard
        guest.send({"type": "join", "code": "nope"})
        missing = guest.recv()
        assert missing["type"] == "error", missing
        print("ws tests passed")
    finally:
        host.close()
        guest.close()
        httpd.shutdown()
        try:
            os.remove(db_path)
        except OSError:
            pass


if __name__ == "__main__":
    main()
