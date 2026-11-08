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

    @pytest.mark.parametrize("raw,masked", [
        ("dave@luebke.us", "da…@luebke.us"), ("Mom.Smith@Example.org", "mo…@example.org"),
        ("a@x.test", "a…@x.test"), ("", "(none)"), (None, "(none)"), ("not-an-address", "no…"),
    ])
    def test_mask_address(self, raw, masked):
        assert addresses.mask_address(raw) == masked

    def test_address(self):
        assert addresses.address("parents", "cudo", "team.example") == "parents-cudo@team.example"
        assert addresses.address("all", "cudo", "team.example") == "cudo@team.example"
        assert addresses.address("player", "cudo", "team.example", "alice") == "alice-cudo@team.example"
        with pytest.raises(ValueError):
            addresses.address("player", "cudo", "team.example")


class TestSpellings:
    """The subdomain spelling (team@cudo.<base>) and the resolver over every
    domain shape — Comms Phase 0.5."""
    BASE = "breakside.pro"
    LIST = "team.breakside.pro"
    SLUGS = ["cudo", "mixed", "cudo-mixed"]
    EVENTS = {"cudo-states": ("cudo", "states"), "mixed-states": ("mixed", "states")}
    FORWARDS = {"help": "owner@x.test", "postmaster": "owner@x.test"}

    def resolve(self, addr, base=BASE, forwards=FORWARDS):
        local, domain = addresses.split_address(addr)
        return addresses.resolve(local, domain, list_domain=self.LIST, base_domain=base,
                                 slugs=self.SLUGS, event_locals=self.EVENTS, forwards=forwards)

    @pytest.mark.parametrize("addr,expected", [
        # the list spelling, unchanged
        ("parents-cudo@team.breakside.pro", ("parents", "cudo", None)),
        ("alice-cudo-mixed@team.breakside.pro", ("player", "cudo-mixed", "alice")),
        ("cudo-states@team.breakside.pro", ("event", "cudo", "states")),
        # the subdomain spelling: the team is the domain
        ("team@cudo.breakside.pro", ("all", "cudo", None)),
        ("cudo@cudo.breakside.pro", ("all", "cudo", None)),
        ("Parents@CUDO.breakside.pro", ("parents", "cudo", None)),
        ("coaches@cudo-mixed.breakside.pro", ("coaches", "cudo-mixed", None)),
        ("coach@cudo.breakside.pro", ("coaches", "cudo", None)),                    # synonym, singular
        ("coach-cudo@team.breakside.pro", ("coaches", "cudo", None)),
        ("coach-cudo@breakside.pro", ("coaches", "cudo", None)),
        ("alice@cudo.breakside.pro", ("player", "cudo", "alice")),
        ("mary-kate@mixed.breakside.pro", ("player", "mixed", "mary-kate")),
        ("states@cudo.breakside.pro", ("event", "cudo", "states")),
        ("states@mixed.breakside.pro", ("event", "mixed", "states")),
        ("states@cudo-mixed.breakside.pro", ("player", "cudo-mixed", "states")),   # no such event there
        ("parents@cudo.breakside.pro.", ("parents", "cudo", None)),                 # trailing dot folded
        # the apex: a slug is everyone, and the list spelling works there too
        ("cudo@breakside.pro", ("all", "cudo", None)),
        ("parents-cudo@breakside.pro", ("parents", "cudo", None)),
        ("alice-mixed@breakside.pro", ("player", "mixed", "alice")),
    ])
    def test_lists_resolve_in_every_spelling(self, addr, expected):
        t = self.resolve(addr)
        assert (t.kind, t.slug, t.alias) == expected
        # every spelling lands on the same canonical key
        assert t.local == addresses.local_part(*expected)

    @pytest.mark.parametrize("addr", [
        "nobody@zzz.breakside.pro",          # unregistered subdomain: the wildcard MX brings it, we drop it
        "team@breakside.pro",                # 'team' is not a slug
        "x@team.breakside.pro",              # not a slug at the list domain
        "parents@cudo.example.org",          # not our domain at all
        "admin@cudo.breakside.pro",          # reserved word is nobody's alias
        "@cudo.breakside.pro",
    ])
    def test_unknown(self, addr):
        assert self.resolve(addr) is None

    def test_forwards_only_at_the_apex(self):
        t = self.resolve("Help@breakside.pro")
        assert (t.kind, t.alias, t.forward_to, t.local) == ("forward", "help", "owner@x.test", "help")
        assert self.resolve("help@cudo.breakside.pro") is None            # not a player on cudo either: reserved
        assert self.resolve("help@team.breakside.pro") is None
        assert self.resolve("help@breakside.pro", forwards=None) is None   # nothing configured, 'help' is no slug

    def test_without_a_base_domain_only_the_list_domain_counts(self):
        assert self.resolve("parents-cudo@team.breakside.pro", base="").kind == "parents"
        assert self.resolve("team@cudo.breakside.pro", base="") is None
        assert self.resolve("cudo@breakside.pro", base="") is None
        assert addresses.is_our_domain("cudo.breakside.pro", list_domain=self.LIST, base_domain="") is False
        assert addresses.is_our_domain("cudo.breakside.pro", list_domain=self.LIST, base_domain=self.BASE) is True
        assert addresses.is_our_domain("breakside.pro", list_domain=self.LIST, base_domain=self.BASE) is True
        assert addresses.is_our_domain("notbreakside.pro", list_domain=self.LIST, base_domain=self.BASE) is False

    def test_render_both_spellings(self):
        kw = dict(base_domain=self.BASE, style="subdomain")
        assert addresses.address("all", "cudo", self.LIST, **kw) == "team@cudo.breakside.pro"
        assert addresses.address("parents", "cudo", self.LIST, **kw) == "parents@cudo.breakside.pro"
        assert addresses.address("player", "cudo", self.LIST, "alice", **kw) == "alice@cudo.breakside.pro"
        assert addresses.address("event", "cudo", self.LIST, "states", **kw) == "states@cudo.breakside.pro"
        assert addresses.apex_address("cudo", self.BASE) == "cudo@breakside.pro"
        # list style, or no base domain, is the old spelling
        assert addresses.address("parents", "cudo", self.LIST, base_domain=self.BASE, style="list") == "parents-cudo@team.breakside.pro"
        assert addresses.address("parents", "cudo", self.LIST, base_domain="", style="subdomain") == "parents-cudo@team.breakside.pro"
        with pytest.raises(ValueError):
            addresses.subdomain_local("player", "cudo")

    def test_zone_hostnames_are_reserved_slugs(self):
        for host in ("api", "staging", "www", "team", "app"):
            with pytest.raises(addresses.AddressError):
                addresses.validate_slug(host)

    def test_synonyms_are_nobodys_name(self):
        for bad in ("coach", "coach-cudo"):
            with pytest.raises(addresses.AddressError):
                addresses.validate_slug(bad)
        for bad in ("coach",):
            with pytest.raises(addresses.AddressError):
                addresses.validate_alias(bad)
            with pytest.raises(addresses.AddressError):
                addresses.validate_event_slug(bad)
        assert addresses.make_alias("Coach", []) == "coach2"
        # the legacy parser reads the synonym as the list, never as a player
        assert addresses.parse_local_part("coach-cudo", ["cudo"]) == ("coaches", "cudo", None)


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

    def test_several_addresses_per_contact(self):
        two = contact("guardian", "g1@x.test", playerIds=["Alice-1"], emails=["g1@x.test", "g2@x.test"],
                      bounces={"g2@x.test": {"kind": "hard", "at": "x"}})
        assert policy.contact_addresses(two) == ["g1@x.test", "g2@x.test"]
        assert policy.deliverable_addresses(two) == ["g1@x.test"]
        assert emails(policy.recipients_for("parents", [COACH1, two])) == ["c1@x.test", "g1@x.test"]
        assert policy.find_contacts_by_email([two], "G2@x.test") == [two]
        d = policy.decide(DIRECTORY, "parents", None, "g2@x.test", [COACH1, MOM, two])
        assert emails(d.recipients) == ["c1@x.test", "g1@x.test", "mom@x.test"]   # author included; g2 is hard-bounced
        assert policy.contact_addresses({"email": "legacy@x.test"}) == ["legacy@x.test"]
        assert policy.deliverable_addresses({"email": "legacy@x.test", "bounce": {"kind": "hard"}}) == []

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
    def test_relay_includes_author(self):
        """The author gets their own copy, like on any mailing list."""
        d = policy.decide(DIRECTORY, "parents", None, "mom@x.test", ALL)
        assert d.action == "relay" and d.reason is None
        assert "mom@x.test" in emails(d.recipients)
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
        # SES's own Delivery Status Notification, as received on 2026-09-20.
        ({"from": "MAILER-DAEMON@amazonses.com",
          "content-type": 'multipart/report; \n\tboundary="----=_Part_1"; \n\treport-type=delivery-status'}, "auto-delivery-report"),
        ({"from": "Bob <bob@x.test>", "content-type": 'multipart/report; report-type="feedback-report"; boundary=y'}, "auto-report"),
        ({"from": "Mail Delivery System <postmaster@x.test>"}, "auto-mailer-daemon"),
        ({"from": "mailer-daemon@x.test"}, "auto-mailer-daemon"),
        ({"from": "Bob <bob@x.test>", "return-path": "<>"}, "auto-null-sender"),
        ({"from": "Bob <bob@x.test>", "return-path": "<bob@x.test>", "content-type": "multipart/mixed; boundary=z"}, None),
    ])
    def test_loop_reason(self, headers, expected):
        assert policy.loop_reason(headers, "team.breakside.pro") == expected

    def test_own_address_by_resolution(self):
        """With a resolver the guard asks "is this From one of our lists", in
        any spelling; a system forward (help@) is a person's identity, not a
        loop; without one it falls back to the domain match."""
        lists = {"parents@cudo.breakside.pro", "parents-cudo@team.breakside.pro", "cudo@breakside.pro"}
        is_own = lambda addr: addr in lists
        assert policy.loop_reason({"from": "List <parents@cudo.breakside.pro>"}, "team.breakside.pro", is_own=is_own) == "loop-own-address"
        assert policy.loop_reason({"from": "List <CUDO@breakside.pro>"}, "team.breakside.pro", is_own=is_own) == "loop-own-address"
        assert policy.loop_reason({"from": "Dave <help@breakside.pro>"}, "team.breakside.pro", is_own=is_own) is None
        assert policy.loop_reason({"from": "Dave <help@breakside.pro>"}, "breakside.pro") == "loop-own-address"   # legacy check

    def test_forward_skips_only_the_precedence_check(self):
        assert policy.loop_reason({"precedence": "bulk", "from": "r@dmarc.example"}, "breakside.pro", forward=True) is None
        assert policy.loop_reason({"precedence": "list", "from": "r@dmarc.example"}, "breakside.pro", forward=False) == "loop-precedence"
        assert policy.loop_reason({"x-breakside-list": "help", "from": "r@x.test"}, "breakside.pro", forward=True) == "loop-own-header"
        assert policy.loop_reason({"auto-submitted": "auto-replied", "from": "r@x.test"}, "breakside.pro", forward=True) == "loop-auto-submitted"

    def test_null_envelope_sender(self):
        h = {"from": "Bob <bob@x.test>"}
        assert policy.loop_reason(h, "team.breakside.pro", envelope_from="<>") == "auto-null-sender"
        assert policy.loop_reason(h, "team.breakside.pro", envelope_from="") == "auto-null-sender"
        assert policy.loop_reason(h, "team.breakside.pro", envelope_from="bob@x.test") is None
        assert policy.loop_reason(h, "team.breakside.pro", envelope_from=None) is None

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

    def test_reply_to_adds_author_outside_the_list(self):
        out = parsed(rewrite.rewrite_message(simple(), list_address=LIST, list_display="X", subject_tag="",
                                             reply_to_mode="list", also_reply_to=("Zed Q", "zed@x.test")))
        assert [a.addr_spec for a in out["Reply-To"].addresses] == [LIST, "zed@x.test"]
        assert out["Reply-To"].addresses[1].display_name == "Zed Q"
        out = parsed(rewrite.rewrite_message(simple(), list_address=LIST, list_display="X", subject_tag="",
                                             reply_to_mode="coaches", coaches_address="coaches-cudo@team.breakside.pro",
                                             also_reply_to=("", "zed@x.test")))
        assert [a.addr_spec for a in out["Reply-To"].addresses] == ["coaches-cudo@team.breakside.pro", "zed@x.test"]
        # author mode: they are the Reply-To already
        out = parsed(rewrite.rewrite_message(simple(), list_address=LIST, list_display="X", subject_tag="",
                                             reply_to_mode="author", also_reply_to=("Zed Q", "zed@x.test")))
        assert [a.addr_spec for a in out["Reply-To"].addresses] == ["bob@yahoo.com"]
        # no duplicate when the extra address is the list itself
        out = parsed(rewrite.rewrite_message(simple(), list_address=LIST, list_display="X", subject_tag="",
                                             reply_to_mode="list", also_reply_to=("", LIST.upper())))
        assert [a.addr_spec for a in out["Reply-To"].addresses] == [LIST]

    def test_reply_to_lists_names_every_alias_a_copy_covers(self):
        aliases = [("Alice Smith (CUDO)", "alice-cudo@team.breakside.pro"), ("Bob Jones (CUDO)", "bob-cudo@team.breakside.pro")]
        out = parsed(rewrite.rewrite_message(simple(), list_address=aliases[0][1], list_display="Alice Smith, Bob Jones (CUDO)",
                                             subject_tag="", reply_to_mode="list", reply_to_lists=aliases))
        assert [(a.display_name, a.addr_spec) for a in out["Reply-To"].addresses] == aliases
        assert out["From"].addresses[0].addr_spec == aliases[0][1]
        assert out["List-Post"] == f"<mailto:{aliases[0][1]}>"
        # the author outside both aliases is appended once; one already among them is not
        out = parsed(rewrite.rewrite_message(simple(), list_address=aliases[0][1], list_display="X", subject_tag="",
                                             reply_to_mode="list", reply_to_lists=aliases, also_reply_to=("Zed Q", "zed@x.test")))
        assert [a.addr_spec for a in out["Reply-To"].addresses] == [aliases[0][1], aliases[1][1], "zed@x.test"]
        out = parsed(rewrite.rewrite_message(simple(), list_address=aliases[0][1], list_display="X", subject_tag="",
                                             reply_to_mode="list", reply_to_lists=aliases, also_reply_to=("", aliases[1][1].upper())))
        assert [a.addr_spec for a in out["Reply-To"].addresses] == [aliases[0][1], aliases[1][1]]
        # coaches and author modes ignore it
        out = parsed(rewrite.rewrite_message(simple(), list_address=aliases[0][1], list_display="X", subject_tag="",
                                             reply_to_mode="coaches", coaches_address="coaches-cudo@team.breakside.pro", reply_to_lists=aliases))
        assert [a.addr_spec for a in out["Reply-To"].addresses] == ["coaches-cudo@team.breakside.pro"]
        out = parsed(rewrite.rewrite_message(simple(), list_address=aliases[0][1], list_display="X", subject_tag="",
                                             reply_to_mode="author", reply_to_lists=aliases))
        assert [a.addr_spec for a in out["Reply-To"].addresses] == ["bob@yahoo.com"]

    def test_rfc2369_headers_point_at_the_coaches(self):
        out = parsed(rewrite.rewrite_message(simple(extra=["List-Unsubscribe: <http://evil.example/unsub>"]),
                                             list_address=LIST, list_display="X", subject_tag="", reply_to_mode="list",
                                             coaches_address="coaches-cudo@team.breakside.pro"))
        # Long values fold after the colon when serialized; strip the fold's leading space.
        assert [v.strip() for v in out.get_all("List-Unsubscribe")] == ["<mailto:coaches-cudo@team.breakside.pro?subject=unsubscribe%20parents-cudo>"]
        assert out["List-Help"].strip() == "<mailto:coaches-cudo@team.breakside.pro?subject=help%20parents-cudo>"
        assert out["List-Owner"].strip() == "<mailto:coaches-cudo@team.breakside.pro>"
        out = parsed(rewrite.rewrite_message(simple(), list_address=LIST, list_display="X", subject_tag="", reply_to_mode="list"))
        assert out["List-Owner"].strip() == f"<mailto:{LIST}>"     # no coaches address known: the list itself

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

    def test_list_key_pins_list_id_and_marker_to_the_canonical_spelling(self):
        """The subdomain spelling goes out as From, but List-Id, the RFC 2369
        subjects and X-Breakside-List carry the list key at the list domain,
        so a parent's filter on List-Id survives the change of spelling."""
        out = parsed(rewrite.rewrite_message(simple(), list_address="parents@cudo.breakside.pro", list_display="Parents CUDO",
                                             subject_tag="", reply_to_mode="coaches", coaches_address="coaches@cudo.breakside.pro",
                                             list_key="parents-cudo", list_id_domain="team.breakside.pro"))
        assert out["From"].addresses[0].addr_spec == "parents@cudo.breakside.pro"
        assert out["List-Id"] == '"Parents CUDO" <parents-cudo.team.breakside.pro>'
        assert out["List-Post"].strip() == "<mailto:parents@cudo.breakside.pro>"
        assert out["List-Unsubscribe"].strip() == "<mailto:coaches@cudo.breakside.pro?subject=unsubscribe%20parents-cudo>"
        assert out["X-Breakside-List"] == "parents-cudo"

    def test_forward_has_no_list_headers(self):
        out = parsed(rewrite.rewrite_message(simple(), list_address="help@breakside.pro",
                                             list_display="Breakside Help", subject_tag="", reply_to_mode="author",
                                             list_key="help", list_headers=False))
        assert str(out["From"]) == "Bob Smith via Breakside Help <help@breakside.pro>"
        assert out["Reply-To"].addresses[0].addr_spec == "bob@yahoo.com"
        assert out["To"].addresses[0].addr_spec == LIST       # untouched: the recipient's send-as identity keys on it
        assert out["X-Breakside-List"] == "help"
        for h in ("List-Id", "List-Post", "List-Unsubscribe", "List-Help", "List-Owner", "Precedence"):
            assert out[h] is None, h
        assert out["Subject"] == "Carpool"
        assert policy.loop_reason(rewrite.header_map(out), "breakside.pro", forward=True) == "loop-own-header"

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


class TestExcerpt:
    """rewrite.excerpt: the opening of the author's own text for the notice."""

    @staticmethod
    def _raw(body, ctype="text/plain; charset=utf-8"):
        return ("From: a@x.test\r\nTo: b@x.test\r\nSubject: s\r\n"
                f"Content-Type: {ctype}\r\n\r\n{body}").encode()

    def test_reply_keeps_only_the_new_text(self):
        body = ("Yes, 8 works.\n\nThanks!\n\nOn Mon, Sep 1, 2026 at 9:00 AM Coach <c@x.test> wrote:\n"
                "> Does 8 work for everyone?\n> Please reply.\n")
        assert rewrite.excerpt(self._raw(body)) == "Yes, 8 works. Thanks!"

    def test_outlook_separator_and_signature_cut(self):
        assert rewrite.excerpt(self._raw("Running late.\n-----Original Message-----\nFrom: x\n")) == "Running late."
        assert rewrite.excerpt(self._raw("Running late.\n-- \nPat\n555-0100\n")) == "Running late."

    def test_html_is_stripped_and_unescaped(self):
        body = "<html><body><p>Tom &amp; Jerry<br>are <b>in</b>.</p><style>p{}</style></body></html>"
        assert rewrite.excerpt(self._raw(body, "text/html; charset=utf-8")) == "Tom & Jerry are in ."

    def test_truncates_at_a_word_with_an_ellipsis(self):
        text = " ".join(f"word{i}" for i in range(100))
        out = rewrite.excerpt(self._raw(text), limit=50)
        assert out.endswith("\u2026") and len(out) <= 51 and not out[:-1].endswith("word")  # cut on a boundary
        assert out[:-1] == text[:len(out) - 1]

    def test_empty_and_garbage(self):
        assert rewrite.excerpt(self._raw("")) == ""
        # Headerless bytes parse as a body (the stdlib parser never fails);
        # what matters is that neither helper raises on them.
        assert isinstance(rewrite.excerpt(b"\xff\xfe not mail at all"), str)
        assert isinstance(rewrite.text_preview(b"\xff\xfe not mail at all"), str)

