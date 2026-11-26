"""
In-app feedback (POST /api/feedback): the message reaches the help@ forward
target with the user in Reply-To and the diagnostics in the body; the
refusals map to the statuses the app's dialog handles.
Run: python -m pytest test_feedback.py -v
"""
import email
from email import policy as email_policy

import pytest
from fastapi.testclient import TestClient

ALICE = {"id": "fb-alice", "email": "alice@x.test", "role": "authenticated"}
BOB = {"id": "fb-bob", "email": "bob@x.test", "role": "authenticated"}
# Signed in, but never synced to a profile record (no display name anywhere).
CAROL = {"id": "fb-carol", "email": "Carol@X.test", "role": "authenticated"}
SUPPORT_INBOX = "inbox@support.test"


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Isolated users dir, a file-outbox transport, a help= forward, a base
    domain, and fresh rate limits."""
    import config
    from storage import user_storage
    from mail import transport, feedback

    patches = [
        (config, "DATA_DIR", tmp_path),
        (config, "USERS_DIR", tmp_path / "users"),
        (user_storage, "USERS_DIR", tmp_path / "users"),
        (config, "MAIL_DOMAIN", "team.breakside.pro"),
        (config, "MAIL_BASE_DOMAIN", "breakside.pro"),
        (config, "MAIL_FORWARDS", f"help={SUPPORT_INBOX},postmaster=pm@support.test"),
    ]
    saved = [(mod, name, getattr(mod, name)) for mod, name, _ in patches]
    for mod, name, value in patches:
        if name.endswith("_DIR"):
            value.mkdir(parents=True, exist_ok=True)
        setattr(mod, name, value)
    monkeypatch.setenv("BREAKSIDE_AUTH_REQUIRED", "true")

    user_storage.create_or_update_user(ALICE["id"], ALICE["email"], "alice")
    user_storage.update_user(ALICE["id"], {"displayName": "Alice Coach"})
    user_storage.create_or_update_user(BOB["id"], BOB["email"], "bob")

    outbox = transport.FileTransport(tmp_path / "outbox")
    transport.set_transport(outbox)
    feedback.reset_rate_limits()

    yield {"outbox": outbox, "feedback": feedback, "config": config}

    from main import app
    app.dependency_overrides.clear()
    transport.set_transport(None)
    feedback.reset_rate_limits()
    for mod, name, original in saved:
        setattr(mod, name, original)


@pytest.fixture
def client(env):
    from main import app
    return TestClient(app)


def _as(user):
    from main import app
    from auth.jwt_validation import get_current_user
    app.dependency_overrides[get_current_user] = lambda: user


def _parse(raw: bytes):
    return email.message_from_bytes(raw, policy=email_policy.default)


DIAGNOSTICS = {
    "App": "2.29.0 (build 1234)",
    "Team": "Alice Team (Alice-Team-7f3a)",
    "Game": "2026-11-20_Alice-Team_vs_Bob-Team_1700000000000",
}


class TestSend:
    def test_reaches_the_forward_target_shaped_like_a_help_forward(self, client, env):
        _as(ALICE)
        r = client.post("/api/feedback", json={
            "message": "The score went backwards\nafter an undo.", "diagnostics": DIAGNOSTICS})
        assert r.status_code == 200 and r.json() == {"status": "sent"}

        [sent] = env["outbox"].sent()
        assert sent["recipients"] == [SUPPORT_INBOX]
        msg = _parse(sent["raw"])
        assert msg["From"].addresses[0].addr_spec == "help@breakside.pro"
        assert msg["From"].addresses[0].display_name == "Alice Coach via Breakside Feedback"
        # To is the support address, so replying from the inbox answers as help@.
        assert msg["To"].addresses[0].addr_spec == "help@breakside.pro"
        assert msg["Reply-To"].addresses[0].addr_spec == "alice@x.test"
        assert msg["Subject"] == "Feedback: The score went backwards"
        assert msg["X-Breakside-List"] == "help"   # the relay's loop guard
        body = msg.get_content()
        assert body.startswith("The score went backwards\nafter an undo.\n\n-- \n")
        assert "Alice Coach <alice@x.test>" in body and "fb-alice" in body
        for key, value in DIAGNOSTICS.items():
            assert f"{key}:" in body and value in body

    def test_without_a_profile_the_token_email_stands_in(self, client, env):
        _as(CAROL)
        assert client.post("/api/feedback", json={"message": "Hi"}).status_code == 200
        msg = _parse(env["outbox"].sent()[0]["raw"])
        assert msg["From"].addresses[0].display_name == "carol@x.test via Breakside Feedback"
        assert msg["Reply-To"].addresses[0].addr_spec == "carol@x.test"

    def test_list_domain_when_no_base_domain(self, client, env):
        env["config"].MAIL_BASE_DOMAIN = ""
        _as(ALICE)
        assert client.post("/api/feedback", json={"message": "Hi"}).status_code == 200
        msg = _parse(env["outbox"].sent()[0]["raw"])
        assert msg["From"].addresses[0].addr_spec == "help@team.breakside.pro"

    def test_diagnostics_are_flattened_trimmed_and_capped(self, env):
        fb = env["feedback"]
        pairs = fb.clean_diagnostics({
            "Nested": {"a": 1}, "List": [1, 2], "None": None,
            "Multi\nline": "one\r\ntwo\tthree", "Long": "x" * 1000, "Number": 7, "Flag": False,
        })
        assert pairs[0] == ("Multi line", "one two three")
        assert pairs[1][0] == "Long" and len(pairs[1][1]) == fb.MAX_VALUE_CHARS
        assert ("Number", "7") in pairs and ("Flag", "False") in pairs
        assert not any(k in ("Nested", "List", "None") for k, _ in pairs)
        many = fb.clean_diagnostics({f"k{i}": "v" for i in range(100)})
        assert len(many) == fb.MAX_DIAGNOSTICS
        assert fb.clean_diagnostics("not a dict") == []

    def test_a_header_injection_attempt_stays_in_the_body(self, client, env):
        user_storage = __import__("storage").user_storage
        user_storage.update_user(ALICE["id"], {"displayName": "Alice\r\nBcc: victim@x.test"})
        _as(ALICE)
        r = client.post("/api/feedback", json={"message": "Subject line\r\nBcc: victim@x.test\n\nrest"})
        assert r.status_code == 200
        [sent] = env["outbox"].sent()
        assert sent["recipients"] == [SUPPORT_INBOX]
        msg = _parse(sent["raw"])
        assert msg["Bcc"] is None
        assert msg["Subject"] == "Feedback: Subject line"


class TestRefusals:
    def test_requires_sign_in(self, client, env):
        r = client.post("/api/feedback", json={"message": "Hi"})
        assert r.status_code in (401, 403)
        assert env["outbox"].sent() == []

    @pytest.mark.parametrize("body", [{}, {"message": ""}, {"message": "   \n "}, {"message": 42}])
    def test_empty_message(self, client, env, body):
        _as(ALICE)
        assert client.post("/api/feedback", json=body).status_code == 400

    def test_over_long_message(self, client, env):
        _as(ALICE)
        r = client.post("/api/feedback", json={"message": "x" * (env["feedback"].MAX_MESSAGE_CHARS + 1)})
        assert r.status_code == 400 and "under" in r.json()["detail"]

    def test_not_configured(self, client, env):
        env["config"].MAIL_FORWARDS = "postmaster=pm@support.test"
        _as(ALICE)
        assert client.post("/api/feedback", json={"message": "Hi"}).status_code == 503

    def test_per_user_rate_limit(self, client, env):
        _as(ALICE)
        for _ in range(env["feedback"].PER_USER_PER_HOUR):
            assert client.post("/api/feedback", json={"message": "Hi"}).status_code == 200
        r = client.post("/api/feedback", json={"message": "Hi"})
        assert r.status_code == 429 and int(r.headers["Retry-After"]) > 0
        _as(BOB)   # someone else is unaffected
        assert client.post("/api/feedback", json={"message": "Hi"}).status_code == 200

    def test_global_rate_limit(self, client, env, monkeypatch):
        monkeypatch.setattr(env["feedback"], "GLOBAL_PER_HOUR", 2)
        _as(ALICE)
        assert client.post("/api/feedback", json={"message": "1"}).status_code == 200
        assert client.post("/api/feedback", json={"message": "2"}).status_code == 200
        _as(BOB)
        assert client.post("/api/feedback", json={"message": "3"}).status_code == 429

    def test_a_failed_send_is_a_502_and_does_not_use_up_the_limit(self, client, env):
        from mail import transport

        class Refusing:
            name = "refusing"

            def send(self, **_):
                raise transport.TransportError("SES said no")

        transport.set_transport(Refusing())
        _as(ALICE)
        for _ in range(env["feedback"].PER_USER_PER_HOUR + 1):
            assert client.post("/api/feedback", json={"message": "Hi"}).status_code == 502
        transport.set_transport(env["outbox"])
        assert client.post("/api/feedback", json={"message": "Hi"}).status_code == 200
