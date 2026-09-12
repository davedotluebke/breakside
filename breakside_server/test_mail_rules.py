"""
Pure-rule tests for team mailing lists: address shapes, delivery policy and
the From-rewrite. No disk, no app. Run: python -m pytest test_mail_rules.py
"""
import email
from email import policy as email_policy
from email.message import EmailMessage

import pytest

from mail import addresses, policy, rewrite


# =============================================================================
# addresses
# =============================================================================

class TestSlug:
    @pytest.mark.parametrize("raw,expected", [
        ("cudo", "cudo"), ("CUDO", "cudo"), (" cudo-mixed ", "cudo-mixed"), ("Édition", "edition"),
    ])
    def test_valid(self, raw, expected):
        assert addresses.validate_slug(raw) == expected

    @pytest.mark.parametrize("bad", [
        "", "c", "x" * 25, "cudo mixed", "cudo--mixed", "-cudo", "cudo-", "cu.do", "cudo_1",
        "help", "postmaster", "parents", "coaches-cudo", "staff-x", "all",
    ])
    def test_invalid(self, bad):
        with pytest.raises(addresses.AddressError):
            addresses.validate_slug(bad)


class TestAlias:
    def test_first_name_then_initial_then_number(self):
        taken = []
        for name, expected in [("Alice Smith", "alice"), ("Alice Wong", "alice-w"),
                               ("Alice Wong", "alice2"), ("Alice", "alice3")]:
            alias = addresses.make_alias(name, taken)
            assert alias == expected
            taken.append(alias)

    def test_folds_accents_and_punctuation(self):
        assert addresses.make_alias("José Álvarez-Núñez", []) == "jose"
        assert addresses.make_alias("O'Brien", []) == "obrien"

    def test_never_reserved(self):
        assert addresses.make_alias("Coach", []) == "coach2"
        assert addresses.make_alias("Parents Smith", []) == "parents-s"
        assert addresses.make_alias("", []) == "teammate"

    def test_validate_alias(self):
        assert addresses.validate_alias("Mary-Kate") == "mary-kate"
        for bad in ("", "parents", "help", "a b", "x" * 25):
            with pytest.raises(addresses.AddressError):
                addresses.validate_alias(bad)


class TestParse:
    SLUGS = ["mixed", "cudo-mixed", "cudo"]

    @pytest.mark.parametrize("local,expected", [
        ("cudo", ("all", "cudo", None)),
        ("parents-cudo", ("parents", "cudo", None)),
        ("Coaches-CUDO", ("coaches", "cudo", None)),
        ("staff-cudo", ("staff", "cudo", None)),
        ("players-cudo", ("players", "cudo", None)),
        ("alice-cudo", ("player", "cudo", "alice")),
        ("mary-kate-cudo", ("player", "cudo", "mary-kate")),
        ("parents-cudo-mixed", ("parents", "cudo-mixed", None)),   # longest slug wins
        ("alice-cudo-mixed", ("player", "cudo-mixed", "alice")),
        ("alice-mixed", ("player", "mixed", "alice")),
        ("nobody", None),
        ("-cudo", None),
        ("bad..name-cudo", None),
    ])
    def test_parse(self, local, expected):
        assert addresses.parse_local_part(local, self.SLUGS) == expected

    def test_address(self):
        assert addresses.address("parents", "cudo", "team.example") == "parents-cudo@team.example"
        assert addresses.address("all", "cudo", "team.example") == "cudo@team.example"
        assert addresses.address("player", "cudo", "team.example", "alice") == "alice-cudo@team.example"
        with pytest.raises(ValueError):
            addresses.address("player", "cudo", "team.example")


# =============================================================================
# policy
# =============================================================================

def contact(kind, email, name=None, **extra):
    base = {"id": f"{kind}:{email}", "kind": kind, "name": name or email.split("@")[0],
            "email": email, "playerIds": [], "alias": None, "status": "active",
            "optOut": [], "bounce": None}
    base.update(extra)
    return base


COACH1 = contact("coach", "c1@x.test")
COACH2 = contact("coach", "c2@x.test")
ALICE = contact("player", None, "Alice", playerIds=["Alice-1"], alias="alice")
BOB = contact("player", "bob@x.test", "Bob", playerIds=["Bob-2"], alias="bob")
MOM = contact("guardian", "mom@x.test", playerIds=["Alice-1"])
DAD = contact("guardian", "dad@x.test", playerIds=["Alice-1", "Bob-2"])
MGR = contact("manager", "mgr@x.test")
OTHER = contact("other", "director@x.test")
ALL = [COACH1, COACH2, ALICE, BOB, MOM, DAD, MGR, OTHER]


def emails(contacts):
    return sorted(c["email"] for c in contacts)


class TestRecipients:
    def test_all(self):
        assert emails(policy.recipients_for("all", ALL)) == sorted(
            ["c1@x.test", "c2@x.test", "bob@x.test", "mom@x.test", "dad@x.test", "mgr@x.test", "director@x.test"])

    def test_parents_staff_coaches_players(self):
        assert emails(policy.recipients_for("parents", ALL)) == sorted(["c1@x.test", "c2@x.test", "mom@x.test", "dad@x.test", "mgr@x.test"])
        assert emails(policy.recipients_for("coaches", ALL)) == ["c1@x.test", "c2@x.test"]
        assert emails(policy.recipients_for("staff", ALL)) == sorted(["c1@x.test", "c2@x.test", "mgr@x.test"])
        assert emails(policy.recipients_for("players", ALL)) == sorted(["c1@x.test", "c2@x.test", "bob@x.test"])

    def test_player_alias_is_player_guardians_coaches(self):
        assert emails(policy.recipients_for("player", ALL, alias="alice")) == sorted(["mom@x.test", "dad@x.test", "c1@x.test", "c2@x.test"])
        assert emails(policy.recipients_for("player", ALL, alias="bob")) == sorted(["bob@x.test", "dad@x.test", "c1@x.test", "c2@x.test"])
        assert policy.recipients_for("player", ALL, alias="nobody") is None

    def test_status_bounce_and_optout(self):
        paused = contact("guardian", "paused@x.test", playerIds=["Alice-1"], status="paused")
        alumni = contact("guardian", "alum@x.test", playerIds=["Alice-1"], status="alumni")
        bounced = contact("guardian", "hard@x.test", playerIds=["Alice-1"], bounce={"kind": "hard", "at": "x"})
        soft = contact("guardian", "soft@x.test", playerIds=["Alice-1"], bounce={"kind": "soft", "at": "x"})
        opted = contact("guardian", "opt@x.test", playerIds=["Alice-1"], optOut=["parents"])
        contacts = [COACH1, paused, alumni, bounced, soft, opted]
        assert emails(policy.recipients_for("parents", contacts)) == ["c1@x.test", "soft@x.test"]
        assert emails(policy.recipients_for("all", contacts)) == ["c1@x.test", "opt@x.test", "soft@x.test"]

    def test_dedupe_parent_coach(self):
        both = [COACH1, contact("guardian", "c1@x.test", playerIds=["Alice-1"])]
        assert emails(policy.recipients_for("parents", both)) == ["c1@x.test"]


DIRECTORY = {
    "slug": "cudo",
    "lists": {
        "all": {"enabled": True, "postPolicy": ["coach", "manager", "guardian"], "subjectTag": "[C]", "replyTo": "coaches"},
        "parents": {"enabled": True, "postPolicy": ["coach", "manager", "guardian"], "subjectTag": "[C P]", "replyTo": "list"},
        "coaches": {"enabled": True, "postPolicy": ["anyone"], "subjectTag": "", "replyTo": "list"},
        "players": {"enabled": False, "postPolicy": ["coach", "player"], "subjectTag": "", "replyTo": "list"},
        "player": {"enabled": True, "postPolicy": ["anyone"], "subjectTag": "", "replyTo": "list"},
    },
}


class TestDecide:
    def test_relay_excludes_sender(self):
        d = policy.decide(DIRECTORY, "parents", None, "mom@x.test", ALL)
        assert d.action == "relay" and d.reason is None
        assert "mom@x.test" not in emails(d.recipients)
        assert d.sender is MOM and d.sender_kinds == ["guardian"]

    def test_unknown_sender_quarantined(self):
        d = policy.decide(DIRECTORY, "parents", None, "stranger@x.test", ALL)
        assert (d.action, d.reason) == ("quarantine", "unknown-sender")

    def test_policy_blocks_player_on_all(self):
        d = policy.decide(DIRECTORY, "all", None, "bob@x.test", ALL)
        assert (d.action, d.reason) == ("quarantine", "not-allowed-to-post")

    def test_anyone_may_post_to_coaches(self):
        d = policy.decide(DIRECTORY, "coaches", None, "director@x.test", ALL)
        assert d.action == "relay" and emails(d.recipients) == ["c1@x.test", "c2@x.test"]

    def test_disabled_list(self):
        d = policy.decide(DIRECTORY, "players", None, "c1@x.test", ALL)
        assert (d.action, d.reason) == ("quarantine", "list-disabled")

    def test_unknown_alias(self):
        d = policy.decide(DIRECTORY, "player", "zed", "c1@x.test", ALL)
        assert (d.action, d.reason) == ("quarantine", "unknown-alias")

    def test_force_skips_sender_checks_only(self):
        d = policy.decide(DIRECTORY, "all", None, "stranger@x.test", ALL, force=True)
        assert d.action == "relay" and d.sender is None
        d = policy.decide(DIRECTORY, "players", None, "stranger@x.test", ALL, force=True)
        assert d.reason == "list-disabled"

    def test_paused_sender_is_unknown(self):
        paused = contact("guardian", "p@x.test", playerIds=["Alice-1"], status="paused")
        d = policy.decide(DIRECTORY, "parents", None, "p@x.test", ALL + [paused])
        assert d.reason == "unknown-sender"

    def test_too_many_recipients(self):
        crowd = [contact("other", f"u{i}@x.test") for i in range(policy.MAX_RECIPIENTS + 1)]
        d = policy.decide(DIRECTORY, "all", None, "c1@x.test", ALL + crowd)
        assert d.reason == "too-many-recipients"


class TestLoopsAndVerdicts:
    @pytest.mark.parametrize("headers,expected", [
        ({"x-breakside-list": "parents-cudo"}, "loop-own-header"),
        ({"precedence": "Bulk"}, "loop-precedence"),
        ({"auto-submitted": "auto-replied"}, "loop-auto-submitted"),
        ({"auto-submitted": "no"}, None),
        ({"from": "List <cudo@team.breakside.pro>"}, "loop-own-address"),
        ({"from": "Bob <bob@x.test>", "precedence": "first-class"}, None),
    ])
    def test_loop_reason(self, headers, expected):
        assert policy.loop_reason(headers, "team.breakside.pro") == expected

    @pytest.mark.parametrize("verdicts,expected", [
        (None, None),
        ({"spam": "PASS", "virus": "PASS", "spf": "PASS", "dkim": "PASS", "dmarc": "PASS"}, None),
        ({"spf": "GRAY", "dkim": "GRAY", "dmarc": "GRAY"}, None),
        ({"virus": "FAIL"}, ("drop", "virus")),
        ({"spam": "FAIL"}, ("drop", "spam")),
        ({"dmarc": "FAIL"}, ("quarantine", "dmarc-fail")),
        ({"spf": "FAIL", "dkim": "FAIL", "dmarc": "GRAY"}, ("quarantine", "auth-fail")),
        ({"spf": "FAIL", "dkim": "PASS"}, None),
    ])
    def test_verdicts(self, verdicts, expected):
        assert policy.verdict_reason(verdicts) == expected


# =============================================================================
# rewrite
# =============================================================================

def simple(from_="Bob Smith <bob@yahoo.com>", subject="Carpool", extra=None, body="hi"):
    lines = [f"From: {from_}", "To: parents-cudo@team.breakside.pro", f"Subject: {subject}",
             "Message-ID: <orig@yahoo.com>", "Date: Mon, 1 Sep 2026 10:00:00 -0400"]
    lines += extra or []
    lines += ["Content-Type: text/plain; charset=utf-8", "", body, ""]
    return "\r\n".join(lines).encode()


def parsed(raw):
    return email.message_from_bytes(raw, policy=email_policy.default)


LIST = "parents-cudo@team.breakside.pro"


class TestRewrite:
    def test_from_rewritten_author_kept(self):
        out = parsed(rewrite.rewrite_message(simple(), list_address=LIST, list_display="CUDO Parents",
                                             subject_tag="[CUDO Parents]", reply_to_mode="author"))
        assert out["From"].addresses[0].addr_spec == LIST
        assert out["From"].addresses[0].display_name == "Bob Smith via CUDO Parents"
        assert out["Reply-To"].addresses[0].addr_spec == "bob@yahoo.com"
        assert out["X-Original-From"] == "Bob Smith <bob@yahoo.com>"
        assert out["X-Original-Sender"] == "bob@yahoo.com"
        assert out["Sender"].addresses[0].addr_spec == LIST
        assert out["Subject"] == "[CUDO Parents] Carpool"
        assert out["Message-ID"] == "<orig@yahoo.com>"
        assert out["List-Id"] == '"CUDO Parents" <parents-cudo.team.breakside.pro>'
        assert out["List-Post"] == f"<mailto:{LIST}>"
        assert out["Precedence"] == "list"
        assert out["X-Breakside-List"] == "parents-cudo"
        assert out["To"] == LIST

    def test_reply_to_modes(self):
        out = parsed(rewrite.rewrite_message(simple(extra=["Reply-To: alt@yahoo.com"]), list_address=LIST,
                                             list_display="X", subject_tag="", reply_to_mode="author"))
        assert out["Reply-To"] == "alt@yahoo.com"
        out = parsed(rewrite.rewrite_message(simple(), list_address=LIST, list_display="X",
                                             subject_tag="", reply_to_mode="list"))
        assert out["Reply-To"].addresses[0].addr_spec == LIST
        out = parsed(rewrite.rewrite_message(simple(), list_address=LIST, list_display="X", subject_tag="",
                                             reply_to_mode="coaches", coaches_address="coaches-cudo@team.breakside.pro"))
        assert out["Reply-To"].addresses[0].addr_spec == "coaches-cudo@team.breakside.pro"

    def test_strips_dangerous_headers(self):
        raw = simple(extra=["DKIM-Signature: v=1; d=yahoo.com; b=abc", "Disposition-Notification-To: bob@yahoo.com",
                            "List-Id: other <other.example.com>", "Precedence: first-class", "Bcc: secret@x.test",
                            "References: <a@b> <c@d>", "In-Reply-To: <c@d>"])
        out = parsed(rewrite.rewrite_message(raw, list_address=LIST, list_display="X", subject_tag="", reply_to_mode="list"))
        assert out["DKIM-Signature"] is None
        assert out["Disposition-Notification-To"] is None
        assert out["Bcc"] is None
        assert out.get_all("List-Id") == ['"X" <parents-cudo.team.breakside.pro>']
        assert out["References"] == "<a@b> <c@d>" and out["In-Reply-To"] == "<c@d>"

    def test_subject_tag_rules(self):
        assert rewrite.tagged_subject("Re: Carpool", "[T]") == "Re: [T] Carpool"
        assert rewrite.tagged_subject("RE: FWD: Carpool", "[T]") == "RE: FWD: [T] Carpool"
        assert rewrite.tagged_subject("Re: [T] Carpool", "[T]") == "Re: [T] Carpool"
        assert rewrite.tagged_subject("re: [t] Carpool", "[T]") == "re: [t] Carpool"
        assert rewrite.tagged_subject("", "[T]") == "[T]"
        assert rewrite.tagged_subject("Plain", "") == "Plain"

    def test_subject_marker(self):
        assert rewrite.marked_subject("Practice", "[T]", "[Parent copy]") == "[T] [Parent copy] Practice"
        assert rewrite.marked_subject("Re: [T] Practice", "[T]", "[Parent copy]") == "Re: [T] [Parent copy] Practice"
        assert rewrite.marked_subject("", "[T]", "[Parent copy]") == "[T] [Parent copy]"
        assert rewrite.marked_subject("Re: Practice", "", "[Parent copy]") == "Re: [Parent copy] Practice"
        # a parent's reply carries the marker in; it must not reach the player's copy
        assert rewrite.marked_subject("Re: [T] [Parent copy] Practice", "[T]", "") == "Re: [T] Practice"
        assert rewrite.marked_subject("Re: [T] [parent COPY] Practice", "[T]", "[Parent copy]") == "Re: [T] [Parent copy] Practice"
        assert rewrite.strip_markers("[Parent copy]  Practice  [Parent copy]") == "Practice"
        assert rewrite.strip_markers("Re: [T] [Coach copy] Practice") == "Re: [T] Practice"
        assert rewrite.marked_subject("Practice", "[T]", rewrite.COACH_COPY_MARKER) == "[T] [Coach copy] Practice"
        out = parsed(rewrite.rewrite_message(simple(subject="Practice"), list_address=LIST, list_display="X",
                                             subject_tag="[X]", reply_to_mode="list", subject_marker="[Parent copy]"))
        assert out["Subject"] == "[X] [Parent copy] Practice"

    def test_message_id_generated_when_missing(self):
        raw = b"From: a@b.test\r\nTo: parents-cudo@team.breakside.pro\r\nSubject: x\r\n\r\nbody\r\n"
        out = parsed(rewrite.rewrite_message(raw, list_address=LIST, list_display="X", subject_tag="", reply_to_mode="list"))
        assert out["Message-ID"].endswith("@team.breakside.pro>")

    def test_multipart_attachment_survives(self):
        msg = EmailMessage(policy=email_policy.default)
        msg["From"] = "Bob <bob@yahoo.com>"
        msg["To"] = LIST
        msg["Subject"] = "Roster"
        msg.set_content("see attached")
        payload = bytes(range(256)) * 40
        msg.add_attachment(payload, maintype="application", subtype="octet-stream", filename="roster.bin")
        out = parsed(rewrite.rewrite_message(msg.as_bytes(), list_address=LIST, list_display="X",
                                             subject_tag="[X]", reply_to_mode="list"))
        attachments = list(out.iter_attachments())
        assert len(attachments) == 1
        assert attachments[0].get_filename() == "roster.bin"
        assert attachments[0].get_content() == payload
        assert out.get_body(preferencelist=("plain",)).get_content().strip() == "see attached"

    def test_non_ascii_author(self):
        raw = simple(from_="=?utf-8?q?Jos=C3=A9_=C3=81lvarez?= <jose@x.test>", body="hola")
        out_bytes = rewrite.rewrite_message(raw, list_address=LIST, list_display="CUDO", subject_tag="", reply_to_mode="author")
        out = parsed(out_bytes)
        assert out["From"].addresses[0].display_name == "José Álvarez via CUDO"
        assert out["Reply-To"].addresses[0].addr_spec == "jose@x.test"
        assert b"Jos\xc3\xa9" not in out_bytes.split(b"\r\n\r\n")[0]  # header is RFC 2047 encoded, not raw UTF-8

    def test_sender_of_tolerates_junk(self):
        msg = rewrite.parse_message(b"From: not an address\r\nSubject: x\r\n\r\nbody\r\n")
        assert rewrite.sender_of(msg) == ("", "")

    def test_notice(self):
        raw = rewrite.build_notice(from_address="coaches-cudo@team.breakside.pro", from_display="CUDO team mail",
                                   to_address="c1@x.test", subject="[Held] hi", body="line1\nline2\n", list_local="coaches-cudo")
        out = parsed(raw)
        assert out["Auto-Submitted"] == "auto-generated" and out["X-Breakside-List"] == "coaches-cudo"
        assert out.get_content().startswith("line1")
        assert policy.loop_reason(rewrite.header_map(out), "team.breakside.pro") is not None
