"""
Team mailing lists (Comms Phase 0).

    addresses.py  slug / alias rules and address parsing (pure)
    policy.py     who receives what, who may post, loop detection (pure)
    rewrite.py    the From-rewrite + list headers on a parsed message (pure)
    transport.py  SES / file / null senders
    relay.py      the orchestrator: raw MIME in → decisions, sends, log entries
    inbound.py    SQS long-poller feeding relay.py; bounce/complaint intake

Storage (directory, slug index, log, quarantine) is storage/mail_storage.py.
The HTTP surface is routers/mail.py. Design: TODO.Comms.md § Phase 0.
"""
