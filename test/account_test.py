import json
import os
import sys
import tempfile
import threading
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


def req(port, method, pathname, body=None, cookie=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        "http://127.0.0.1:%s%s" % (port, pathname),
        data=data,
        method=method,
    )
    request.add_header("Content-Type", "application/json")
    if cookie:
        request.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(request) as response:
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw or "{}"), response.headers.get("Set-Cookie")
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8")
        return err.code, json.loads(raw or "{}"), err.headers.get("Set-Cookie")


def token_of(set_cookie):
    if not set_cookie:
        return ""
    part = set_cookie.split(";", 1)[0]
    return part.split("=", 1)[1]


def main():
    db_path = os.path.join(tempfile.gettempdir(), "fanqi-account-%s.db" % os.getpid())
    httpd = server.serve(0, db_path)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    port = httpd.server_address[1]
    try:
        status, _, _ = req(port, "POST", "/api/register", {"username": "a", "password": "123456"})
        assert status == 400, status
        status, body, cookie = req(port, "POST", "/api/register", {"username": "redking", "password": "secret1"})
        assert status == 200 and body["username"] == "redking", body
        session = "fanqi_session=" + token_of(cookie)
        assert token_of(cookie)
        status, _, _ = req(port, "POST", "/api/register", {"username": "RedKing", "password": "secret1"})
        assert status == 409, status
        status, _, _ = req(port, "POST", "/api/login", {"username": "redking", "password": "nope"})
        assert status == 401, status
        status, body, _ = req(port, "GET", "/api/me", cookie=session)
        assert body["username"] == "redking"
        status, _, _ = req(port, "GET", "/api/records")
        assert status == 401
        status, _, _ = req(
            port,
            "PUT",
            "/api/records",
            {"gameId": "g1", "at": 10, "winner": "red", "result": "红方胜", "moves": 3, "specials": {"borrow": 1}},
            session,
        )
        assert status == 200
        status, body, _ = req(port, "GET", "/api/records", cookie=session)
        assert len(body["records"]) == 1
        assert body["records"][0]["result"] == "红方胜"
        assert body["records"][0]["specials"]["borrow"] == 1
        status, _, other = req(port, "POST", "/api/register", {"username": "black", "password": "secret2"})
        assert status == 200
        status, body, _ = req(port, "GET", "/api/records", cookie="fanqi_session=" + token_of(other))
        assert body["records"] == []
        status, _, _ = req(port, "DELETE", "/api/records/g1", cookie=session)
        assert status == 200
        status, body, _ = req(port, "GET", "/api/records", cookie=session)
        assert body["records"] == []
        req(port, "POST", "/api/logout", cookie=session)
        status, _, _ = req(port, "GET", "/api/me", cookie=session)
        assert status == 401
        print("account tests passed")
    finally:
        httpd.shutdown()
        try:
            os.remove(db_path)
        except OSError:
            pass


if __name__ == "__main__":
    main()
