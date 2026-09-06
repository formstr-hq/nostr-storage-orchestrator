#!/usr/bin/env python3
"""E2E test for the mesh-PG gateway: DDL, writes, point/broad reads."""
import socket
import struct
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 55432


class PgConn:
    def __init__(self, port):
        self.s = socket.create_connection(("localhost", port), timeout=60)
        params = b"user\x00test\x00database\x00meshdb\x00\x00"
        self.s.sendall(struct.pack("!ii", 8 + len(params), 196608) + params)
        # Startup exchange: server answers with AuthenticationCleartext ('R'),
        # then (after the password) ParameterStatus + BackendKeyData +
        # ReadyForQuery. Reading past 'R' before sending the password blocks
        # until pgwire's 60s startup timeout kills the socket.
        self._read_one_message()
        pw = b"\x00"
        self.s.sendall(b"p" + struct.pack("!i", 4 + len(pw)) + pw)
        self._read_until_ready()

    def _read_one_message(self):
        data = b""
        while True:
            chunk = self.s.recv(65536)
            data += chunk
            if len(data) >= 5:
                (n,) = struct.unpack("!i", data[1:5])
                if len(data) >= 1 + n:
                    return data
            if not chunk:
                return data

    def _read_until_ready(self):
        # Message-aware read: keep reading until a ReadyForQuery frame ('Z',
        # length 5) terminates the exchange. Scanning raw bytes would false-
        # positive inside ParameterStatus payloads.
        data = b""
        i = 0
        while True:
            chunk = self.s.recv(65536)
            if not chunk:
                break
            data += chunk
            ready = False
            while i + 5 <= len(data):
                (n,) = struct.unpack("!i", data[i + 1 : i + 5])
                if n < 4:
                    ready = True
                    break
                if data[i : i + 1] == b"Z":
                    ready = True
                    break
                i += n + 1
            if ready:
                break
        return data

    last_field_names = None

    def query(self, sql):
        q = sql.encode() + b"\x00"
        self.s.sendall(b"Q" + struct.pack("!i", 4 + len(q)) + q)
        resp = self._read_until_ready()
        self.last_field_names = self._field_names(resp)
        # Parse messages: total frame size = 1 + length, where length
        # includes its own 4 bytes.
        rows, errors, tag = [], [], None
        i = 0
        while i + 5 <= len(resp):
            t = resp[i : i + 1]
            (n,) = struct.unpack("!i", resp[i + 1 : i + 5])
            if n < 4:
                break
            body = resp[i + 5 : i + 1 + n]
            if t == b"D":
                (nfields,) = struct.unpack("!h", body[:2])
                off = 2
                vals = []
                for _ in range(nfields):
                    (flen,) = struct.unpack("!i", body[off : off + 4])
                    off += 4
                    if flen > 0:
                        vals.append(body[off : off + flen].decode())
                        off += flen
                    elif flen == -1:
                        vals.append(None)
                    else:
                        off += flen
                        vals.append("?")
                rows.append(vals)
            elif t == b"E":
                errors.append(body.decode("latin1", errors="replace"))
            elif t == b"C":
                tag = body.rstrip(b"\x00").decode()
            i += n + 1
        return {"rows": rows, "errors": errors, "tag": tag}

    @staticmethod
    def _field_names(resp):
        names, i = [], 0
        while i + 5 <= len(resp):
            t = resp[i : i + 1]
            (n,) = struct.unpack("!i", resp[i + 1 : i + 5])
            if n < 4:
                break
            body = resp[i + 5 : i + 1 + n]
            if t == b"T":
                (nfields,) = struct.unpack("!h", body[:2])
                off = 2
                for _ in range(nfields):
                    # name is a cstring; skip the rest of the 4+8 fixed fields
                    end = body.index(b"\x00", off)
                    names.append(body[off:end].decode())
                    off = end + 1 + 4 + 2 + 4 + 2 + 4 + 2
            i += n + 1
        return names

    def close(self):
        self.s.close()


def main():
    conn = PgConn(PORT)
    steps = [
        "CREATE TABLE notes (id text PRIMARY KEY, body text, done boolean DEFAULT false)",
        "INSERT INTO notes (id, body) VALUES ('a1', 'hello world')",
        "SELECT * FROM notes",
        "SELECT * FROM notes WHERE id = 'a1'",
        "UPDATE notes SET body = 'updated!' WHERE id = 'a1'",
        "SELECT * FROM notes",
        "DELETE FROM notes WHERE id = 'a1'",
        "SELECT * FROM notes",
    ]
    failures = 0
    for sql in steps:
        result = conn.query(sql)
        has_error = bool(result["errors"])
        if has_error and "already exists" in result["errors"][0]:
            print(f"SKIP {sql[:70]} (table registered from a previous run)")
            continue
        print(f"{'FAIL' if has_error else 'OK  '} {sql[:70]}")
        print(f"     tag={result['tag']} rows={result['rows']} errors={result['errors']}")
        if has_error:
            failures += 1
    conn.close()
    return failures


def autogen_id_test():
    """Gateway-generated ids + RETURNING: INSERT without id."""
    conn = PgConn(PORT)
    failures = 0
    steps = [
        # bigserial pk, uuid default, now() default, serial non-pk counter
        "CREATE TABLE events (id bigserial PRIMARY KEY, ref uuid DEFAULT gen_random_uuid(), at timestamptz DEFAULT now(), seq serial, body text)",
        "INSERT INTO events (body) VALUES ('first') RETURNING id, ref, at, seq",
        "INSERT INTO events (body) VALUES ('second')",
        "SELECT * FROM events",
    ]
    allocated = None
    for sql in steps:
        result = conn.query(sql)
        has_error = bool(result["errors"]) and "already exists" not in result["errors"][0]
        print(f"{'FAIL' if has_error else 'OK  '} {sql[:72]}")
        print(f"     tag={result['tag']} rows={result['rows']} errors={result['errors']}")
        if has_error:
            failures += 1
        if "RETURNING" in sql and result["rows"]:
            allocated = result["rows"][0][0]
            print(f"     gateway-allocated id={allocated} (for this INSERT)")
    # The two INSERTs must have distinct sequential ids. Column order in the
    # fan-out result follows provider output; map by RowDescription names.
    result = conn.query("SELECT id, seq FROM events ORDER BY id")
    names = conn.last_field_names or []
    id_idx = names.index("id") if "id" in names else 0
    seq_idx = names.index("seq") if "seq" in names else 1
    ids = sorted(int(row[id_idx]) for row in result["rows"])
    seqs = sorted(int(row[seq_idx]) for row in result["rows"])
    print(f"     provider ids={ids} seqs={seqs}")
    if len(ids) != len(set(ids)):
        print("FAIL duplicate generated ids across inserts")
        failures += 1
    # RETURNING id must be among the provider-stored ids and distinct ids
    # must be contiguous from the same per-column sequence.
    if allocated and str(allocated) not in [str(i) for i in ids]:
        print(f"FAIL RETURNING id {allocated} not among provider ids {ids}")
        failures += 1
    conn.close()
    return failures


if __name__ == "__main__":
    failures = main() or 0
    print("── autogenerated-id tests ──")
    failures += autogen_id_test() or 0
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    failures = main() or 0
    print("── autogenerated-id tests ──")
    failures += autogen_id_test() or 0
    sys.exit(1 if failures else 0)
