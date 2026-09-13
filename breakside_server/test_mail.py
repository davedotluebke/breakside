"""
Team mailing lists, end to end against an isolated data dir: storage, the
relay with a file outbox, the coach-only API, the queue poller with fake AWS
clients, and the erasure hooks. Run: python -m pytest test_mail.py -v
"""
import json

import pytest
from fastapi.testclient import TestClient

COACH = {"id": "mail-coach", "email": "coach@x.test", "role": "authenticated"}
COACH2 = {"id": "mail-coach-2", "email": "coach2@x.test", "role": "authenticated"}
VIEWER = {"id": "mail-viewer", "email": "parent-viewer@x.test", "role": "authenticated"}
OUTSIDER = {"id": "mail-outsider", "email": "out@x.test", "role": "authenticated"}
DOMAIN = "team.breakside.pro"


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Isolated data dir seeded with one team, two coaches, a viewer, three
    players; mail configured with slug ``cudo``, a file-outbox transport."""
    import config
    from storage import (team_storage, player_storage, user_storage, membership_storage,
                         index_storage, mail_storage, tombstones)
    from mail import transport

    patches = [
        (config, "DATA_DIR", tmp_path),
        (config, "TEAMS_DIR", tmp_path / "teams"),
        (config, "PLAYERS_DIR", tmp_path / "players"),
        (config, "USERS_DIR", tmp_path / "users"),
        (config, "MEMBERSHIPS_DIR", tmp_path / "memberships"),
        (config, "INDEX_FILE", tmp_path / "index.json"),
        (config, "MAIL_DIR", tmp_path / "mail"),
        (config, "MAIL_OUTBOX_DIR", tmp_path / "outbox"),
        (config, "MAIL_TRANSPORT", "file"),
        (config, "MAIL_DOMAIN", DOMAIN),
        (team_storage, "TEAMS_DIR", tmp_path / "teams"),
        (player_storage, "PLAYERS_DIR", tmp_path / "players"),
        (user_storage, "USERS_DIR", tmp_path / "users"),
        (membership_storage, "MEMBERSHIPS_DIR", tmp_path / "memberships"),
        (membership_storage, "INDEX_FILE", tmp_path / "memberships" / "_index.json"),
        (index_storage, "INDEX_FILE", tmp_path / "index.json"),
        (index_storage, "GAMES_DIR", tmp_path / "games"),
        (index_storage, "TEAMS_DIR", tmp_path / "teams"),
        (index_storage, "PLAYERS_DIR", tmp_path / "players"),
        (mail_storage, "MAIL_DIR", tmp_path / "mail"),
        # The erasure tests record tombstones; keep them out of the repo's data/.
        (tombstones, "ERASED_FILE", tmp_path / "erased.json"),
    ]
    saved = [(mod, name, getattr(mod, name)) for mod, name, _ in patches]
    for mod, name, value in patches:
        if name.endswith("_DIR") and hasattr(value, "mkdir"):
            value.mkdir(parents=True, exist_ok=True)
        setattr(mod, name, value)
    monkeypatch.setenv("BREAKSIDE_AUTH_REQUIRED", "true")
    monkeypatch.delenv("BREAKSIDE_MAIL_QUEUE_URL", raising=False)

    for u in (COACH, COACH2, VIEWER, OUTSIDER):
        user_storage.create_or_update_user(u["id"], u["email"], u["email"].split("@")[0])
    user_storage.update_user(COACH["id"], {"displayName": "Coach Dave"})
    alice = player_storage.save_player({"name": "Alice Smith"})
    bob = player_storage.save_player({"name": "Bob Jones"})
    alice2 = player_storage.save_player({"name": "Alice Wong"})
    team_id = team_storage.save_team({"name": "CUDO Mixed", "playerIds": [alice, bob, alice2]})
    other_team = team_storage.save_team({"name": "Other Team", "playerIds": []})
    membership_storage.create_membership(team_id, COACH["id"], "coach")
    membership_storage.create_membership(team_id, COACH2["id"], "coach")
    membership_storage.create_membership(team_id, VIEWER["id"], "viewer")
    membership_storage.create_membership(other_team, OUTSIDER["id"], "coach")
    index_storage.rebuild_index()

    outbox = transport.FileTransport(tmp_path / "outbox")
    transport.set_transport(outbox)

    yield {"team_id": team_id, "other_team": other_team, "alice": alice, "bob": bob,
           "alice2": alice2, "outbox": outbox, "tmp": tmp_path}

    from main import app
    app.dependency_overrides.clear()
    transport.set_transport(None)
    for mod, name, original in saved:
        setattr(mod, name, original)


@pytest.fixture
def configured(env):
    """env plus a directory: slug cudo, player aliases, two guardians for
    Alice Smith (mom, dad — dad also Bob's), Bob with his own email, a manager."""
    from storage import mail_storage
    from mail import directory as directory_mod
    mail_storage.create_mail_directory(env["team_id"], "cudo", "CUDO")
    directory_mod.ensure_player_aliases(env["team_id"])
    add = lambda c: mail_storage.add_mail_contact(env["team_id"], c)
    env["mom"] = add({"kind": "guardian", "name": "Mom Smith", "email": "mom@x.test", "playerIds": [env["alice"]]})
    env["dad"] = add({"kind": "guardian", "name": "Dad Smith", "email": "dad@x.test", "playerIds": [env["alice"], env["bob"]]})
    env["mgr"] = add({"kind": "manager", "name": "Carol Manager", "email": "carol@x.test"})
    d = mail_storage.get_mail_directory(env["team_id"])
    bob_contact = next(c for c in d["contacts"] if c["kind"] == "player" and c["playerIds"] == [env["bob"]])
    mail_storage.update_mail_contact(env["team_id"], bob_contact["id"], {"email": "bob@x.test"})
    env["directory"] = mail_storage.get_mail_directory(env["team_id"])
    return env


def raw_mail(from_, to, subject="Carpool Saturday", extra=(), body="See you at 8."):
    lines = [f"From: {from_}", f"To: {to}", f"Subject: {subject}", "Message-ID: <m1@x.test>",
             "Date: Mon, 1 Sep 2026 10:00:00 -0400", *extra, "Content-Type: text/plain; charset=utf-8", "", body, ""]
    return "\r\n".join(lines).encode()


def sent_to(outbox):
    return [sorted(e["recipients"]) for e in outbox.sent()]


# =============================================================================
# Storage
# =============================================================================

class TestStorage:
    def test_create_and_slug_uniqueness(self, env):
        from storage import mail_storage as ms
        ms.create_mail_directory(env["team_id"], "cudo", "CUDO")
        assert ms.resolve_mail_slug("cudo") == env["team_id"]
        with pytest.raises(ValueError):
            ms.create_mail_directory(env["other_team"], "cudo", "Other")
        with pytest.raises(ValueError):
            ms.create_mail_directory(env["team_id"], "again", "CUDO")
        ms.update_mail_settings(env["team_id"], slug="cudo-mixed", display_name="CUDO Mixed")
        assert ms.resolve_mail_slug("cudo") is None
        assert ms.resolve_mail_slug("cudo-mixed") == env["team_id"]
        assert ms.get_mail_slug_for_team(env["team_id"]) == "cudo-mixed"
        assert ms.delete_mail_directory(env["team_id"]) is True
        assert ms.resolve_mail_slug("cudo-mixed") is None and ms.get_mail_directory(env["team_id"]) is None

    def test_defaults(self, configured):
        lists = configured["directory"]["lists"]
        assert lists["all"]["postPolicy"] == ["coach", "manager", "guardian"] and lists["all"]["replyTo"] == "coaches"
        assert lists["players"]["enabled"] is False
        assert lists["coaches"]["postPolicy"] == ["anyone"]
        assert lists["parents"]["subjectTag"] == "[CUDO Parents]"

    def test_aliases_from_roster(self, configured):
        players = {c["name"]: c["alias"] for c in configured["directory"]["contacts"] if c["kind"] == "player"}
        assert players == {"Alice Smith": "alice", "Alice Wong": "alice-w", "Bob Jones": "bob"}
        from mail import directory as dm
        assert dm.ensure_player_aliases(configured["team_id"]) == []   # idempotent

    def test_contact_validation(self, configured):
        from storage import mail_storage as ms
        tid = configured["team_id"]
        for bad in (
            {"kind": "guardian", "name": "X", "email": "x@x.test"},                       # no player
            {"kind": "manager", "name": "X"},                                              # no email
            {"kind": "manager", "name": "X", "email": "not-an-email"},
            {"kind": "manager", "name": "X", "email": "y@x.test", "alias": "y"},           # alias on non-player
            {"kind": "player", "name": "Alice Smith", "playerIds": [configured["alice"]], "alias": "zz"},  # dup player
            {"kind": "player", "name": "New Kid", "playerIds": ["New-1"], "alias": "alice"},   # dup alias
            {"kind": "manager", "name": "Carol Again", "email": "carol@x.test"},            # dup email+kind
            {"kind": "wizard", "name": "X", "email": "w@x.test"},
        ):
            with pytest.raises(ValueError):
                ms.add_mail_contact(tid, bad)
        # same email, different kind is fine (a parent who also manages)
        ms.add_mail_contact(tid, {"kind": "guardian", "name": "Carol Manager", "email": "carol@x.test",
                                  "playerIds": [configured["bob"]]})
        with pytest.raises(ValueError):
            ms.update_mail_contact(tid, configured["mom"]["id"], {"status": "gone"})
        with pytest.raises(ValueError):
            ms.update_mail_contact(tid, configured["mom"]["id"], {"optOut": ["nope"]})
        assert ms.update_mail_contact(tid, "mc_missing", {"name": "x"}) is None
        assert ms.remove_mail_contact(tid, "mc_missing") is False

    def test_list_updates(self, configured):
        from storage import mail_storage as ms
        tid = configured["team_id"]
        s = ms.update_mail_list(tid, "players", {"enabled": True, "postPolicy": ["anyone", "coach"], "subjectTag": " [P] ", "replyTo": "author"})
        assert s == {"enabled": True, "postPolicy": ["anyone"], "subjectTag": "[P]", "replyTo": "author"}
        for bad in ({"postPolicy": []}, {"postPolicy": ["ghost"]}, {"replyTo": "me"}, {"subjectTag": "x" * 41}):
            with pytest.raises(ValueError):
                ms.update_mail_list(tid, "all", bad)
        with pytest.raises(ValueError):
            ms.update_mail_list(tid, "nope", {"enabled": True})

    def test_log_and_quarantine(self, configured):
        from storage import mail_storage as ms
        tid = configured["team_id"]
        for i in range(5):
            ms.append_mail_log(tid, {"action": "relayed", "list": "cudo", "subject": f"s{i}", "recipients": 1})
        entries = ms.read_mail_log(tid, limit=3)
        assert [e["subject"] for e in entries] == ["s4", "s3", "s2"]
        item = ms.add_mail_quarantine(tid, {"list": "parents-cudo", "from": "a@x.test", "subject": "held", "reason": "unknown-sender"}, b"raw bytes")
        assert ms.list_mail_quarantine(tid)[0]["id"] == item["id"] and item["size"] == 9
        meta, raw = ms.get_mail_quarantine(tid, item["id"])
        assert raw == b"raw bytes" and meta["reason"] == "unknown-sender"
        assert ms.purge_expired_quarantine(tid, days=14) == 0
        assert ms.purge_expired_quarantine(tid, days=-1) == 1
        assert ms.get_mail_quarantine(tid, item["id"]) is None

    def test_bounce_recording(self, configured):
        from storage import mail_storage as ms
        tid = configured["team_id"]
        assert ms.record_mail_bounce("DAD@x.test", "hard", "550 no such user") == 1
        dad = ms.get_mail_contact(tid, configured["dad"]["id"])
        assert dad["bounces"]["dad@x.test"]["kind"] == "hard"
        assert ms.read_mail_log(tid, 1)[0]["action"] == "bounce"
        ms.update_mail_contact(tid, dad["id"], {"bounce": None})          # old clear form still accepted
        assert ms.get_mail_contact(tid, dad["id"])["bounces"] == {}
        assert ms.record_mail_bounce("nobody@x.test", "hard") == 0

    def test_multiple_addresses(self, configured):
        from storage import mail_storage as ms
        tid = configured["team_id"]
        gran = ms.add_mail_contact(tid, {"kind": "guardian", "name": "Gran", "email": "Gran@x.test, gran2@x.test; gran3@x.test",
                                         "playerIds": [configured["alice"]]})
        assert gran["emails"] == ["gran@x.test", "gran2@x.test", "gran3@x.test"] and gran["email"] == "gran@x.test"
        with pytest.raises(ValueError):   # shares one address with an existing guardian
            ms.add_mail_contact(tid, {"kind": "guardian", "name": "Dup", "emails": ["new@x.test", "gran2@x.test"], "playerIds": [configured["bob"]]})
        with pytest.raises(ValueError):
            ms.add_mail_contact(tid, {"kind": "manager", "name": "Bad", "emails": "ok@x.test, not-an-address"})
        assert ms.record_mail_bounce("gran2@x.test", "hard") == 1
        gran = ms.update_mail_contact(tid, gran["id"], {"emails": ["gran@x.test", "gran3@x.test"]})   # dropped address takes its bounce along
        assert gran["emails"] == ["gran@x.test", "gran3@x.test"] and gran["bounces"] == {}
        bob = next(c for c in ms.get_mail_directory(tid)["contacts"] if c["kind"] == "player" and c["playerIds"] == [configured["bob"]])
        bob = ms.update_mail_contact(tid, bob["id"], {"emails": "bob@x.test bob.school@x.test"})
        assert bob["emails"] == ["bob@x.test", "bob.school@x.test"]
        bob = ms.update_mail_contact(tid, bob["id"], {"emails": ""})
        assert bob["emails"] == [] and bob["email"] is None

    def test_legacy_single_email_directory_reads_cleanly(self, configured):
        """A directory written before multi-address support (one ``email``,
        one ``bounce``) needs no migration."""
        import json
        from storage import mail_storage as ms
        from mail import policy, relay
        tid = configured["team_id"]
        path = ms._directory_file(tid)
        raw = json.loads(path.read_text())
        for c in raw["contacts"]:
            c.pop("emails", None); c.pop("bounces", None)
            c["bounce"] = {"at": "x", "kind": "soft", "detail": "greylisted"} if c["name"] == "Mom Smith" else None
        path.write_text(json.dumps(raw))
        d = ms.get_mail_directory(tid)
        mom = next(c for c in d["contacts"] if c["name"] == "Mom Smith")
        assert mom["emails"] == ["mom@x.test"] and mom["email"] == "mom@x.test"
        assert mom["bounces"] == {"mom@x.test": {"at": "x", "kind": "soft", "detail": "greylisted"}} and "bounce" not in mom
        assert policy.find_contacts_by_email(d["contacts"], "mom@x.test")[0]["name"] == "Mom Smith"
        r = relay.process_inbound(raw_mail("dad@x.test", f"parents-cudo@{DOMAIN}"), envelope_recipients=[f"parents-cudo@{DOMAIN}"])
        assert r[0].action == "relay" and "mom@x.test" in configured["outbox"].sent()[-1]["recipients"]


# =============================================================================
# Relay
# =============================================================================

class TestRelay:
    def test_parent_post_to_parents(self, configured):
        from mail import relay
        from storage import mail_storage as ms
        results = relay.process_inbound(raw_mail("Mom Smith <mom@x.test>", f"parents-cudo@{DOMAIN}"),
                                        envelope_recipients=[f"parents-cudo@{DOMAIN}"], source="test")
        assert [r.action for r in results] == ["relay"]
        assert results[0].recipients == 5
        sends = configured["outbox"].sent()
        assert len(sends) == 1
        assert sends[0]["from"] == f"parents-cudo@{DOMAIN}"
        # the author is on the envelope too (Gmail merges it with her Sent copy)
        assert sorted(sends[0]["recipients"]) == ["carol@x.test", "coach2@x.test", "coach@x.test", "dad@x.test", "mom@x.test"]
        head = sends[0]["raw"].split(b"\r\n\r\n")[0].decode()
        assert f"From: Mom Smith via CUDO Parents <parents-cudo@{DOMAIN}>" in head
        assert "Subject: [CUDO Parents] Carpool Saturday" in head
        assert f"Reply-To: CUDO Parents <parents-cudo@{DOMAIN}>" in head
        assert f"To: parents-cudo@{DOMAIN}" in head
        entry = ms.read_mail_log(configured["team_id"], 1)[0]
        assert entry["action"] == "relayed" and entry["recipients"] == 5 and entry["senderKinds"] == ["guardian"]

    def test_all_list_reply_to_coaches_and_player_blocked(self, configured):
        from mail import relay
        results = relay.process_inbound(raw_mail("Dad <dad@x.test>", f"cudo@{DOMAIN}"), envelope_recipients=[f"cudo@{DOMAIN}"])
        assert results[0].action == "relay"
        head = configured["outbox"].sent()[-1]["raw"].split(b"\r\n\r\n")[0].decode()
        assert f"Reply-To: CUDO coaches <coaches-cudo@{DOMAIN}>" in head
        assert sorted(configured["outbox"].sent()[-1]["recipients"]) == ["bob@x.test", "carol@x.test", "coach2@x.test", "coach@x.test", "dad@x.test", "mom@x.test"]
        results = relay.process_inbound(raw_mail("Bob <bob@x.test>", f"cudo@{DOMAIN}"), envelope_recipients=[f"cudo@{DOMAIN}"])
        assert (results[0].action, results[0].reason) == ("quarantine", "not-allowed-to-post")

    def test_unknown_sender_quarantined_and_coaches_notified(self, configured):
        from mail import relay
        from storage import mail_storage as ms
        results = relay.process_inbound(raw_mail("Stranger <stranger@x.test>", f"parents-cudo@{DOMAIN}", subject="Buy stuff"),
                                        envelope_recipients=[f"parents-cudo@{DOMAIN}"])
        assert (results[0].action, results[0].reason) == ("quarantine", "unknown-sender")
        held = ms.list_mail_quarantine(configured["team_id"])
        assert len(held) == 1 and held[0]["from"] == "stranger@x.test" and held[0]["subject"] == "Buy stuff"
        sends = configured["outbox"].sent()
        assert len(sends) == 1 and sorted(sends[0]["recipients"]) == ["coach2@x.test", "coach@x.test"]
        notice = sends[0]["raw"].decode()
        assert "Subject: [Held] Buy stuff" in notice and "not in the team directory" in notice
        assert "Auto-Submitted: auto-generated" in notice
        # Feeding the notice back in must never relay it (loop guard).
        back = relay.process_inbound(sends[0]["raw"], envelope_recipients=[f"coaches-cudo@{DOMAIN}"])
        assert back[0].action == "drop" and back[0].reason.startswith("loop")

    def test_notification_rate_limit(self, configured):
        from mail import relay
        relay._notify_times.clear()
        for i in range(relay.NOTIFY_MAX_PER_HOUR + 3):
            relay.process_inbound(raw_mail(f"s{i}@spam.test", f"parents-cudo@{DOMAIN}"), envelope_recipients=[f"parents-cudo@{DOMAIN}"])
        assert len(configured["outbox"].sent()) == relay.NOTIFY_MAX_PER_HOUR
        relay._notify_times.clear()

    def test_release_with_add_sender(self, configured):
        from mail import relay
        from storage import mail_storage as ms
        tid = configured["team_id"]
        relay.process_inbound(raw_mail("New Parent <newp@x.test>", f"parents-cudo@{DOMAIN}"), envelope_recipients=[f"parents-cudo@{DOMAIN}"])
        held = ms.list_mail_quarantine(tid)[0]
        before = len(configured["outbox"].sent())
        results = relay.release_quarantine(tid, held["id"], add_sender={"kind": "guardian", "name": "New Parent", "playerIds": [configured["bob"]]})
        assert results[0].action == "relay" and results[0].recipients == 6      # the newly added sender included
        assert ms.list_mail_quarantine(tid) == []
        assert any(c["email"] == "newp@x.test" for c in ms.get_mail_directory(tid)["contacts"])
        assert len(configured["outbox"].sent()) == before + 1
        newest = ms.read_mail_log(tid, 2)
        assert newest[0]["action"] == "released" and newest[1]["action"] == "quarantined"   # one row per release
        with pytest.raises(KeyError):
            relay.release_quarantine(tid, held["id"])
        # next message from them relays directly
        results = relay.process_inbound(raw_mail("New Parent <newp@x.test>", f"parents-cudo@{DOMAIN}"), envelope_recipients=[f"parents-cudo@{DOMAIN}"])
        assert results[0].action == "relay"

    def test_player_alias_copies_guardians_and_coaches(self, configured):
        from mail import relay
        results = relay.process_inbound(raw_mail("Coach Dave <coach@x.test>", f"alice-cudo@{DOMAIN}", subject="Practice"),
                                        envelope_recipients=[f"alice-cudo@{DOMAIN}"])
        assert results[0].action == "relay" and results[0].recipients == 4
        import email as email_lib
        from email import policy as email_policy
        # Alice has no email; guardians and coaches (the author among them) get SEPARATE copies,
        # each group's copy carrying its own marker.
        sends = configured["outbox"].sent()
        assert len(sends) == 2
        by_recipients = {tuple(sorted(s["recipients"])): email_lib.message_from_bytes(s["raw"], policy=email_policy.default) for s in sends}
        guardians = by_recipients[("dad@x.test", "mom@x.test")]
        coaches = by_recipients[("coach2@x.test", "coach@x.test")]
        assert guardians["Subject"] == "[CUDO] [Parent copy] Practice"
        assert coaches["Subject"] == "[CUDO] [Coach copy] Practice"
        for out in (guardians, coaches):
            assert out["From"].addresses[0].display_name == "Coach Dave via CUDO (Alice Smith)"
            assert out["From"].addresses[0].addr_spec == f"alice-cudo@{DOMAIN}"
            assert out["Message-ID"] == "<m1@x.test>"
        from storage import mail_storage as ms
        assert ms.read_mail_log(configured["team_id"], 1)[0]["copies"] == {"guardian": 2, "coach": 2}
        # A parent's reply carries the marker; the player's own copy must not.
        results = relay.process_inbound(raw_mail("Mom <mom@x.test>", f"bob-cudo@{DOMAIN}", subject="Re: [CUDO] [Parent copy] Practice"),
                                        envelope_recipients=[f"bob-cudo@{DOMAIN}"])
        assert results[0].recipients == 4
        sends = configured["outbox"].sent()[-3:]
        subjects = {tuple(sorted(s["recipients"])): email_lib.message_from_bytes(s["raw"], policy=email_policy.default)["Subject"] for s in sends}
        assert subjects[("bob@x.test",)] == "Re: [CUDO] Practice"
        assert subjects[("dad@x.test",)] == "Re: [CUDO] [Parent copy] Practice"
        assert subjects[("coach2@x.test", "coach@x.test")] == "Re: [CUDO] [Coach copy] Practice"
        results = relay.process_inbound(raw_mail("Mom <mom@x.test>", f"zed-cudo@{DOMAIN}"), envelope_recipients=[f"zed-cudo@{DOMAIN}"])
        assert (results[0].action, results[0].reason) == ("quarantine", "unknown-alias")

    def test_loop_verdicts_and_unknown_address(self, configured):
        from mail import relay
        r = relay.process_inbound(raw_mail("mom@x.test", f"parents-cudo@{DOMAIN}", extra=["X-Breakside-List: parents-cudo"]),
                                  envelope_recipients=[f"parents-cudo@{DOMAIN}"])
        assert (r[0].action, r[0].reason) == ("drop", "loop-own-header")
        r = relay.process_inbound(raw_mail("mom@x.test", f"parents-cudo@{DOMAIN}"), envelope_recipients=[f"parents-cudo@{DOMAIN}"],
                                  verdicts={"spam": "FAIL"})
        assert (r[0].action, r[0].reason) == ("drop", "spam")
        r = relay.process_inbound(raw_mail("mom@x.test", f"parents-cudo@{DOMAIN}"), envelope_recipients=[f"parents-cudo@{DOMAIN}"],
                                  verdicts={"spam": "PASS", "dmarc": "FAIL"})
        assert (r[0].action, r[0].reason) == ("quarantine", "dmarc-fail")
        r = relay.process_inbound(raw_mail("mom@x.test", f"nothing@{DOMAIN}"), envelope_recipients=[f"nothing@{DOMAIN}"])
        assert (r[0].action, r[0].reason, r[0].team_id) == ("drop", "unknown-address", None)
        r = relay.process_inbound(raw_mail("mom@x.test", "mom@x.test"), envelope_recipients=["mom@x.test"])
        assert r == []
        # Only the dmarc-fail hold produced a send: the notice to the coaches.
        sends = configured["outbox"].sent()
        assert len(sends) == 1 and sends[0]["from"] == f"coaches-cudo@{DOMAIN}"

    def test_disabled_players_list_then_enabled(self, configured):
        from mail import relay
        from storage import mail_storage as ms
        r = relay.process_inbound(raw_mail("coach@x.test", f"players-cudo@{DOMAIN}"), envelope_recipients=[f"players-cudo@{DOMAIN}"])
        assert (r[0].action, r[0].reason) == ("quarantine", "list-disabled")
        ms.update_mail_list(configured["team_id"], "players", {"enabled": True})
        r = relay.process_inbound(raw_mail("coach@x.test", f"players-cudo@{DOMAIN}"), envelope_recipients=[f"players-cudo@{DOMAIN}"])
        assert r[0].action == "relay"
        assert sorted(configured["outbox"].sent()[-1]["recipients"]) == ["bob@x.test", "coach2@x.test", "coach@x.test"]

    def test_optout_bounce_dedupe_and_multiple_targets(self, configured):
        from mail import relay
        from storage import mail_storage as ms
        tid = configured["team_id"]
        ms.update_mail_contact(tid, configured["mom"]["id"], {"optOut": ["parents"]})
        ms.record_mail_bounce("carol@x.test", "hard")
        # coach2 is also a guardian under the same address: one copy
        ms.add_mail_contact(tid, {"kind": "guardian", "name": "Coach Two", "email": "coach2@x.test", "playerIds": [configured["alice"]]})
        r = relay.process_inbound(raw_mail("dad@x.test", f"parents-cudo@{DOMAIN}, coaches-cudo@{DOMAIN}"),
                                  envelope_recipients=[f"parents-cudo@{DOMAIN}", f"coaches-cudo@{DOMAIN}"])
        assert [x.action for x in r] == ["relay", "relay"]
        sends = configured["outbox"].sent()
        assert sorted(sends[0]["recipients"]) == ["coach2@x.test", "coach@x.test", "dad@x.test"]   # mom opted out, carol bounced, dad (author) included
        assert sorted(sends[1]["recipients"]) == ["coach2@x.test", "coach@x.test"]
        assert "X-Breakside-List: coaches-cudo" in sends[1]["raw"].decode()

    def test_contacts_with_several_addresses(self, configured):
        from mail import relay
        from storage import mail_storage as ms
        tid = configured["team_id"]
        bob = next(c for c in ms.get_mail_directory(tid)["contacts"] if c["kind"] == "player" and c["playerIds"] == [configured["bob"]])
        ms.update_mail_contact(tid, bob["id"], {"emails": ["bob@x.test", "bob.school@x.test"]})
        ms.update_mail_contact(tid, configured["dad"]["id"], {"emails": ["dad@x.test", "dad.work@x.test"]})
        # Coach writes to Bob: Bob's copy goes to both of his addresses; Dad's copy to both of his.
        r = relay.process_inbound(raw_mail("coach@x.test", f"bob-cudo@{DOMAIN}"), envelope_recipients=[f"bob-cudo@{DOMAIN}"])
        assert r[0].recipients == 6
        sends = {tuple(sorted(s["recipients"])) for s in configured["outbox"].sent()}
        assert ("bob.school@x.test", "bob@x.test") in sends
        assert ("dad.work@x.test", "dad@x.test") in sends
        assert ("coach2@x.test", "coach@x.test") in sends
        # Dad posts from his work address: both of his addresses get the relay, like everyone else's.
        r = relay.process_inbound(raw_mail("Dad <dad.work@x.test>", f"parents-cudo@{DOMAIN}"), envelope_recipients=[f"parents-cudo@{DOMAIN}"])
        assert r[0].action == "relay"
        assert sorted(configured["outbox"].sent()[-1]["recipients"]) == ["carol@x.test", "coach2@x.test", "coach@x.test", "dad.work@x.test", "dad@x.test", "mom@x.test"]
        # A hard bounce on one address leaves the other deliverable.
        ms.record_mail_bounce("bob.school@x.test", "hard")
        r = relay.process_inbound(raw_mail("mom@x.test", f"bob-cudo@{DOMAIN}"), envelope_recipients=[f"bob-cudo@{DOMAIN}"])
        sends = {tuple(sorted(s["recipients"])) for s in configured["outbox"].sent()[-3:]}
        assert ("bob@x.test",) in sends

    def test_header_fallback_when_no_envelope(self, configured):
        from mail import relay
        r = relay.process_inbound(raw_mail("mom@x.test", f"Parents <parents-cudo@{DOMAIN}>", extra=[f"Cc: coaches-cudo@{DOMAIN}"]))
        assert sorted(x.address for x in r) == [f"coaches-cudo@{DOMAIN}", f"parents-cudo@{DOMAIN}"]

    def test_test_message(self, configured):
        from mail import relay
        pid = relay.send_test_message(configured["team_id"], "coach@x.test", "Coach Dave")
        send = configured["outbox"].sent()[-1]
        assert send["recipients"] == ["coach@x.test"] and send["from"] == f"cudo@{DOMAIN}"
        raw = send["raw"].decode()
        assert "Subject: [CUDO] Test message" in raw and "Auto-Submitted" not in raw
        assert f"Reply-To: coaches-cudo@{DOMAIN}" in raw


# =============================================================================
# API
# =============================================================================

def _as(user):
    from main import app
    from auth.jwt_validation import get_current_user, get_optional_user
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_optional_user] = lambda: user


@pytest.fixture
def client(env):
    from main import app
    return TestClient(app)


class TestApi:
    def test_access(self, client, env):
        url = f"/api/teams/{env['team_id']}/mail"
        _as(VIEWER)
        assert client.get(url).status_code == 403
        _as(OUTSIDER)
        assert client.get(url).status_code == 403
        assert client.post(url, json={"slug": "cudo"}).status_code == 403
        _as(COACH)
        body = client.get(url).json()
        assert body["configured"] is False and body["domain"] == DOMAIN
        assert sorted(m["email"] for m in body["members"]) == sorted(["coach@x.test", "coach2@x.test", "parent-viewer@x.test"])
        assert client.get("/api/teams/Nope-0000/mail").status_code in (403, 404)

    def test_configure_and_view(self, client, env):
        _as(COACH)
        url = f"/api/teams/{env['team_id']}/mail"
        r = client.post(url, json={"slug": "Cudo"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["configured"] and body["slug"] == "cudo" and body["displayName"] == "CUDO Mixed"
        assert body["addresses"]["parents"] == f"parents-cudo@{DOMAIN}"
        assert body["addresses"]["playerPattern"] == f"<name>-cudo@{DOMAIN}"
        assert {p["alias"] for p in body["roster"]} == {"alice", "alice-w", "bob"}
        assert [c["name"] for c in body["contacts"] if c["kind"] == "coach"] == ["Coach Dave", "coach2"]
        assert all(c.get("derived") for c in body["contacts"] if c["kind"] == "coach")
        assert body["lists"]["coaches"]["recipients"] and body["lists"]["players"]["enabled"] is False
        assert body["quarantineCount"] == 0
        # rename
        r = client.post(url, json={"slug": "cudo-mixed", "displayName": "CUDO"})
        assert r.status_code == 200 and r.json()["addresses"]["all"] == f"cudo-mixed@{DOMAIN}"
        # bad + taken slugs
        assert client.post(url, json={"slug": "parents-x"}).status_code == 400
        _as(OUTSIDER)
        assert client.post(f"/api/teams/{env['other_team']}/mail", json={"slug": "cudo-mixed"}).status_code == 409

    def test_lists_contacts_aliases(self, client, configured):
        _as(COACH)
        tid = configured["team_id"]
        r = client.patch(f"/api/teams/{tid}/mail/lists/players", json={"enabled": True, "replyTo": "author"})
        assert r.status_code == 200 and r.json()["settings"]["enabled"] is True
        assert client.patch(f"/api/teams/{tid}/mail/lists/all", json={"replyTo": "me"}).status_code == 400
        assert client.patch(f"/api/teams/{tid}/mail/lists/ghost", json={"enabled": True}).status_code == 400

        r = client.post(f"/api/teams/{tid}/mail/contacts", json={"kind": "guardian", "name": "Gran", "emails": "gran@x.test, gran.work@x.test", "playerIds": [configured["alice"]]})
        assert r.status_code == 200
        cid = r.json()["contact"]["id"]
        assert r.json()["contact"]["emails"] == ["gran@x.test", "gran.work@x.test"]
        view = client.get(f"/api/teams/{tid}/mail").json()
        assert next(c for c in view["contacts"] if c["id"] == cid)["emails"] == ["gran@x.test", "gran.work@x.test"]
        assert len([x for x in view["lists"]["parents"]["recipients"] if x["id"] == cid]) == 2   # one entry per address
        assert client.post(f"/api/teams/{tid}/mail/contacts", json={"kind": "guardian", "name": "X", "email": "x@x.test"}).status_code == 400
        r = client.patch(f"/api/teams/{tid}/mail/contacts/{cid}", json={"status": "alumni", "optOut": ["all"]})
        assert r.status_code == 200 and r.json()["contact"]["status"] == "alumni"
        assert client.patch(f"/api/teams/{tid}/mail/contacts/mc_none", json={"name": "y"}).status_code == 404
        # alias rename on a player contact
        alice = next(p for p in client.get(f"/api/teams/{tid}/mail").json()["roster"] if p["alias"] == "alice")
        r = client.patch(f"/api/teams/{tid}/mail/contacts/{alice['contactId']}", json={"alias": "Ali"})
        assert r.status_code == 200 and r.json()["contact"]["alias"] == "ali"
        assert client.patch(f"/api/teams/{tid}/mail/contacts/{alice['contactId']}", json={"alias": "parents"}).status_code == 400
        assert client.delete(f"/api/teams/{tid}/mail/contacts/{cid}").status_code == 200
        assert client.delete(f"/api/teams/{tid}/mail/contacts/{cid}").status_code == 404
        # alias sync after a roster addition
        from storage import player_storage, team_storage
        new = player_storage.save_player({"name": "Dana Q"})
        team = team_storage.get_team(tid)
        team["playerIds"].append(new)
        team_storage.update_team(tid, team)
        r = client.post(f"/api/teams/{tid}/mail/aliases/sync")
        assert r.status_code == 200 and [a["alias"] for a in r.json()["added"]] == ["dana"]

    def test_quarantine_and_log_endpoints(self, client, configured):
        from mail import relay
        _as(COACH)
        tid = configured["team_id"]
        relay.process_inbound(raw_mail("New <new@x.test>", f"parents-cudo@{DOMAIN}", subject="Hello", body="Long body here"),
                              envelope_recipients=[f"parents-cudo@{DOMAIN}"])
        items = client.get(f"/api/teams/{tid}/mail/quarantine").json()["items"]
        assert len(items) == 1
        qid = items[0]["id"]
        one = client.get(f"/api/teams/{tid}/mail/quarantine/{qid}").json()
        assert one["preview"].startswith("Long body") and one["reason"] == "unknown-sender"
        r = client.post(f"/api/teams/{tid}/mail/quarantine/{qid}/release", json={"addSender": {"kind": "manager", "name": "New Person"}})
        assert r.status_code == 200 and r.json()["results"][0]["action"] == "relay"
        assert client.get(f"/api/teams/{tid}/mail/quarantine/{qid}").status_code == 404
        assert client.post(f"/api/teams/{tid}/mail/quarantine/{qid}/release").status_code == 404
        relay.process_inbound(raw_mail("spam@x.test", f"parents-cudo@{DOMAIN}"), envelope_recipients=[f"parents-cudo@{DOMAIN}"])
        qid = client.get(f"/api/teams/{tid}/mail/quarantine").json()["items"][0]["id"]
        assert client.delete(f"/api/teams/{tid}/mail/quarantine/{qid}").status_code == 200
        log = client.get(f"/api/teams/{tid}/mail/log?limit=10").json()["entries"]
        assert [e["action"] for e in log][:3] == ["quarantined", "released", "quarantined"]
        r = client.post(f"/api/teams/{tid}/mail/test")
        assert r.status_code == 200 and r.json()["to"] == "coach@x.test" and r.json()["transport"] == "file"

    def test_dev_inbound_gated(self, client, configured, monkeypatch):
        import config
        raw = raw_mail("mom@x.test", f"parents-cudo@{DOMAIN}")
        r = client.post("/api/mail/dev/inbound", content=raw, headers={"Content-Type": "message/rfc822"})
        assert r.status_code == 404
        monkeypatch.setenv("BREAKSIDE_AUTH_REQUIRED", "false")
        r = client.post(f"/api/mail/dev/inbound?to=coaches-cudo@{DOMAIN}", content=raw, headers={"Content-Type": "message/rfc822"})
        assert r.status_code == 200, r.text
        assert r.json()["results"][0]["address"] == f"coaches-cudo@{DOMAIN}"
        assert r.json()["results"][0]["action"] == "relay"
        assert client.post("/api/mail/dev/inbound", content=b"  ").status_code == 400


# =============================================================================
# Inbound poller
# =============================================================================

class FakeSQS:
    def __init__(self, bodies):
        self.messages = [{"MessageId": f"m{i}", "ReceiptHandle": f"h{i}", "Body": b} for i, b in enumerate(bodies)]
        self.deleted = []

    def receive_message(self, **kwargs):
        batch, self.messages = self.messages[:kwargs.get("MaxNumberOfMessages", 10)], self.messages[10:]
        return {"Messages": batch}

    def delete_message(self, QueueUrl, ReceiptHandle):
        self.deleted.append(ReceiptHandle)


class FakeS3:
    def __init__(self, objects):
        self.objects = objects

    def get_object(self, Bucket, Key):
        import io
        return {"Body": io.BytesIO(self.objects[(Bucket, Key)])}


def ses_received(recipients, key, dmarc="PASS"):
    return json.dumps({
        "notificationType": "Received",
        "mail": {"source": "mom@x.test", "destination": recipients, "messageId": key},
        "receipt": {"recipients": recipients, "spamVerdict": {"status": "PASS"}, "virusVerdict": {"status": "PASS"},
                    "spfVerdict": {"status": "PASS"}, "dkimVerdict": {"status": "GRAY"}, "dmarcVerdict": {"status": dmarc},
                    "action": {"type": "S3", "bucketName": "bkt", "objectKey": key}},
    })


class TestInbound:
    def test_received_and_bounce_and_poison(self, configured):
        from mail import inbound
        from storage import mail_storage as ms
        raw = raw_mail("mom@x.test", f"parents-cudo@{DOMAIN}")
        bodies = [
            ses_received([f"parents-cudo@{DOMAIN}"], "inbound/k1"),
            json.dumps({"Type": "Notification", "Message": ses_received([f"coaches-cudo@{DOMAIN}"], "inbound/k2", dmarc="FAIL")}),
            json.dumps({"eventType": "Bounce", "bounce": {"bounceType": "Permanent", "bounceSubType": "General",
                                                          "bouncedRecipients": [{"emailAddress": "dad@x.test", "diagnosticCode": "550"}]}}),
            json.dumps({"notificationType": "Complaint", "complaint": {"complaintFeedbackType": "abuse",
                                                                       "complainedRecipients": [{"emailAddress": "carol@x.test"}]}}),
            json.dumps({"notificationType": "Received", "receipt": {"recipients": [f"parents-cudo@{DOMAIN}"], "action": {}}, "mail": {}}),  # poison: no S3 key
            "not json",
            json.dumps({"eventType": "Delivery"}),
        ]
        poller = inbound.InboundPoller("q", region="us-east-1", bucket="bkt",
                                       sqs_client=FakeSQS(bodies), s3_client=FakeS3({("bkt", "inbound/k1"): raw, ("bkt", "inbound/k2"): raw}))
        handled = poller.poll_once()
        assert handled == 6                      # only the JSON message with no S3 key stays in the queue
        assert poller.processed == 2
        assert sorted(poller.sqs.deleted) == ["h0", "h1", "h2", "h3", "h5", "h6"]
        sends = configured["outbox"].sent()
        assert sends[0]["from"] == f"parents-cudo@{DOMAIN}"                                    # k1 relayed
        assert ms.list_mail_quarantine(configured["team_id"])[0]["reason"] == "dmarc-fail"      # k2 held
        tid = configured["team_id"]
        assert ms.get_mail_contact(tid, configured["dad"]["id"])["bounces"]["dad@x.test"]["kind"] == "hard"
        assert ms.get_mail_contact(tid, configured["mgr"]["id"])["bounces"]["carol@x.test"]["kind"] == "complaint"

    def test_parse_and_verdicts(self):
        from mail import inbound
        assert inbound.parse_notification(json.dumps({"Type": "Notification", "Message": "{\"a\": 1}"})) == {"a": 1}
        assert inbound.parse_notification(json.dumps({"a": 2})) == {"a": 2}
        assert inbound.parse_notification("Successfully validated SNS topic for Amazon SES event publishing.")["Type"] == "Text"
        assert inbound.parse_notification(json.dumps({"Type": "Notification", "Message": "plain text"})) == {"Type": "Text", "text": "plain text"}
        assert inbound.verdicts_from_receipt({"spfVerdict": {"status": "pass"}}) == {"spam": "", "virus": "", "spf": "PASS", "dkim": "", "dmarc": ""}

    def test_build_poller_off_by_default(self, monkeypatch):
        from mail import inbound
        monkeypatch.delenv("BREAKSIDE_MAIL_QUEUE_URL", raising=False)
        assert inbound.build_poller() is None
        monkeypatch.setenv("BREAKSIDE_MAIL_TRANSPORT", "ses")
        monkeypatch.setenv("BREAKSIDE_MAIL_QUEUE_URL", "https://sqs.example/q")
        poller = inbound.build_poller()
        assert poller is not None and poller.queue_url == "https://sqs.example/q"


# =============================================================================
# Erasure hooks
# =============================================================================

class TestErasure:
    def test_erase_player_scrubs_mail(self, configured):
        from storage import erasure, mail_storage as ms
        from mail import relay
        tid = configured["team_id"]
        relay.process_inbound(raw_mail("mom@x.test", f"alice-cudo@{DOMAIN}"), envelope_recipients=[f"alice-cudo@{DOMAIN}"])
        relay.process_inbound(raw_mail("who@x.test", f"alice-cudo@{DOMAIN}"), envelope_recipients=[f"alice-cudo@{DOMAIN}"])
        preview = erasure.erase_player(configured["alice"], dry_run=True)
        assert preview["counts"]["mailContacts"] == 2                  # Alice's alias + mom (only Alice's)
        assert ms.get_mail_directory(tid)["contacts"]                    # untouched by the preview
        result = erasure.erase_player(configured["alice"])
        assert result["counts"]["mailContacts"] == 2
        d = ms.get_mail_directory(tid)
        names = {c["name"] for c in d["contacts"]}
        assert "Alice Smith" not in names and "Mom Smith" not in names
        dad = next(c for c in d["contacts"] if c["name"] == "Dad Smith")
        assert dad["playerIds"] == [configured["bob"]]
        assert ms.list_mail_quarantine(tid) == []
        assert all(e.get("list") != "alice-cudo" for e in ms.read_mail_log(tid, 100))

    def test_erase_team_removes_directory(self, configured):
        from storage import erasure, mail_storage as ms
        tid = configured["team_id"]
        preview = erasure.erase_team(tid, dry_run=True)
        assert preview["counts"]["mailContacts"] == 6
        erasure.erase_team(tid)
        assert ms.get_mail_directory(tid) is None and ms.resolve_mail_slug("cudo") is None
