#!/usr/bin/env bash
# Provision the AWS side of team mailing lists (breakside_server/mail/).
#
#   scripts/setup-mail-aws.sh plan            # print what would be created, change nothing
#   scripts/setup-mail-aws.sh apply           # create / update everything (idempotent)
#   scripts/setup-mail-aws.sh status          # verification state, DNS to publish, env lines
#
# Runs from a maintainer's machine with an admin profile (AWS_PROFILE, default
# "admin"). Every resource is check-before-create, so re-running is safe.
# Nothing deployment-specific is hardcoded: names come from the variables
# below or the environment, and the generated identifiers (bucket, queue URL)
# are printed at the end for the private ops repo and /etc/breakside/env.
#
# What it builds, in order:
#   1. SES domain identity for MAIL_DOMAIN with Easy DKIM, plus a custom
#      MAIL FROM subdomain so SPF aligns.
#   2. Private S3 bucket where SES stores received mail (30-day lifecycle on
#      the inbound/ prefix), with a bucket policy that lets SES write.
#   3. SNS topic + SQS queue (+ dead-letter queue); queue subscribed to the
#      topic with raw delivery; topic policy that lets SES publish.
#   4. SES receipt rule: mail for MAIL_DOMAIN → S3 (+ topic notification),
#      spam/virus scanning on. Added to the ACTIVE rule set if one exists,
#      otherwise a new set is created and activated.
#   5. SES configuration set whose bounce/complaint events go to the topic.
#   6. IAM policy on the API box's instance role: read the queue and bucket,
#      send through the identity.
#
# Then YOU publish the DNS records it prints (MX + 3 DKIM CNAMEs + MAIL FROM
# MX/TXT) and add the env lines to /etc/breakside/env.
set -euo pipefail

# Claude Code Desktop and cron strip PATH; the aws CLI may live in a Homebrew
# prefix that only the login shell knows about.
[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv" || true

MAIL_DOMAIN="${MAIL_DOMAIN:-team.breakside.pro}"
MAIL_FROM_DOMAIN="${MAIL_FROM_DOMAIN:-bounce.$MAIL_DOMAIN}"
REGION="${AWS_REGION:-us-east-1}"
export AWS_PROFILE="${AWS_PROFILE:-admin}"
export AWS_DEFAULT_REGION="$REGION"
export AWS_PAGER=""

NAME="${MAIL_RESOURCE_NAME:-breakside-team-mail}"      # topic, queue, rule, config set
BUCKET="${MAIL_BUCKET:-}"                              # generated on first apply if empty
PREFIX="${MAIL_PREFIX:-inbound/}"
RULESET="${MAIL_RULESET:-$NAME}"
ROLE="${MAIL_INSTANCE_ROLE:-breakside-ssm}"
POLICY_NAME="${MAIL_POLICY_NAME:-BreaksideTeamMail}"
RETENTION_DAYS="${MAIL_RAW_RETENTION_DAYS:-30}"
DMARC_RUA="${MAIL_DMARC_RUA:-}"                        # e.g. mailto:help@example.com

MODE="${1:-plan}"
case "$MODE" in plan|apply|status) ;; *) echo "usage: $0 plan|apply|status" >&2; exit 2;; esac

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
fail() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
doing() { if [[ "$MODE" == "apply" ]]; then printf '\033[32m+ %s\033[0m\n' "$*"; else printf '\033[33m(plan) would %s\033[0m\n' "$*"; fi; }
have() { printf '\033[36m= %s\033[0m\n' "$*"; }
# Run a command only in apply mode. A bare `[[ apply ]] && cmd` returns 1 in
# plan mode, and as the last statement of a function that trips `set -e`.
apply() { [[ "$MODE" == "apply" ]] || return 0; "$@"; }

command -v aws >/dev/null || fail "aws CLI not on PATH"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text) || fail "no AWS credentials for profile $AWS_PROFILE"
bold "account $ACCOUNT, region $REGION, profile $AWS_PROFILE, mode $MODE"

TOPIC_ARN="arn:aws:sns:$REGION:$ACCOUNT:$NAME"
QUEUE_ARN="arn:aws:sqs:$REGION:$ACCOUNT:$NAME"
DLQ_ARN="arn:aws:sqs:$REGION:$ACCOUNT:$NAME-dlq"
IDENTITY_ARN="arn:aws:ses:$REGION:$ACCOUNT:identity/$MAIL_DOMAIN"
CONFIGSET_ARN="arn:aws:ses:$REGION:$ACCOUNT:configuration-set/$NAME"
RULESET_ARN_PREFIX="arn:aws:ses:$REGION:$ACCOUNT:receipt-rule-set/$RULESET"

# ------------------------------------------------------------- 1. identity ----
ensure_identity() {
    bold "1. SES identity $MAIL_DOMAIN"
    if aws sesv2 get-email-identity --email-identity "$MAIL_DOMAIN" >/dev/null 2>&1; then
        have "identity exists"
    else
        doing "create identity with Easy DKIM"
        apply aws sesv2 create-email-identity --email-identity "$MAIL_DOMAIN" \
            --dkim-signing-attributes NextSigningKeyLength=RSA_2048_BIT >/dev/null
    fi
    local current
    current=$(aws sesv2 get-email-identity --email-identity "$MAIL_DOMAIN" --query 'MailFromAttributes.MailFromDomain' --output text 2>/dev/null || echo None)
    if [[ "$current" == "$MAIL_FROM_DOMAIN" ]]; then
        have "MAIL FROM domain $MAIL_FROM_DOMAIN"
    else
        doing "set MAIL FROM domain $MAIL_FROM_DOMAIN"
        apply aws sesv2 put-email-identity-mail-from-attributes \
            --email-identity "$MAIL_DOMAIN" --mail-from-domain "$MAIL_FROM_DOMAIN" \
            --behavior-on-mx-failure USE_DEFAULT_VALUE >/dev/null
    fi
    return 0
}

# ---------- 2. bucket ----
ensure_bucket() {
    bold "2. S3 bucket for received mail"
    if [[ -z "$BUCKET" ]]; then
        # Look for one we made before (tagged), else mint an unguessable name.
        BUCKET=$(aws resourcegroupstaggingapi get-resources --resource-type-filters s3 \
            --tag-filters Key=breakside,Values=team-mail --query 'ResourceTagMappingList[0].ResourceARN' --output text 2>/dev/null | sed 's#arn:aws:s3:::##')
        [[ "$BUCKET" == "None" ]] && BUCKET=""
        if [[ -z "$BUCKET" ]]; then
            BUCKET="bkside-mail-$(openssl rand -hex 6)"
            note "no existing bucket found; will create $BUCKET"
        fi
    fi
    if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
        have "bucket $BUCKET"
    else
        doing "create bucket $BUCKET (private, encrypted, tagged breakside=team-mail)"
        if [[ "$MODE" == "apply" ]]; then
            if [[ "$REGION" == "us-east-1" ]]; then
                aws s3api create-bucket --bucket "$BUCKET" >/dev/null
            else
                aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration LocationConstraint="$REGION" >/dev/null
            fi
            aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
                BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
            aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
                '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
            aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging 'TagSet=[{Key=breakside,Value=team-mail}]'
        fi
    fi
    doing "set $RETENTION_DAYS-day lifecycle on $PREFIX and the SES write policy"
    if [[ "$MODE" == "apply" ]]; then
        aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration "$(cat <<JSON
{"Rules":[{"ID":"expire-inbound","Status":"Enabled","Filter":{"Prefix":"$PREFIX"},
           "Expiration":{"Days":$RETENTION_DAYS},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}]}
JSON
)"
        aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$(cat <<JSON
{"Version":"2012-10-17","Statement":[{"Sid":"AllowSESPuts","Effect":"Allow",
  "Principal":{"Service":"ses.amazonaws.com"},"Action":"s3:PutObject",
  "Resource":"arn:aws:s3:::$BUCKET/$PREFIX*",
  "Condition":{"StringEquals":{"aws:SourceAccount":"$ACCOUNT"},
               "StringLike":{"aws:SourceArn":"arn:aws:ses:$REGION:$ACCOUNT:receipt-rule-set/*:receipt-rule/*"}}}]}
JSON
)"
    fi
    return 0
}

# ---------- 3. topic + queues ----
ensure_topic_and_queues() {
    bold "3. SNS topic + SQS queue ($NAME)"
    if aws sns get-topic-attributes --topic-arn "$TOPIC_ARN" >/dev/null 2>&1; then
        have "topic $TOPIC_ARN"
    else
        doing "create topic $NAME"
        apply aws sns create-topic --name "$NAME" >/dev/null
    fi
    # SNS rejects the "SNS:*" wildcard ("action out of service scope"); the
    # owner statement has to spell the actions out, as the default policy does.
    doing "set topic policy: SES may publish"
    apply aws sns set-topic-attributes --topic-arn "$TOPIC_ARN" --attribute-name Policy --attribute-value "$(cat <<JSON
{"Version":"2012-10-17","Statement":[
 {"Sid":"OwnerFull","Effect":"Allow","Principal":{"AWS":"arn:aws:iam::$ACCOUNT:root"},
  "Action":["SNS:GetTopicAttributes","SNS:SetTopicAttributes","SNS:AddPermission","SNS:RemovePermission",
            "SNS:DeleteTopic","SNS:Subscribe","SNS:ListSubscriptionsByTopic","SNS:Publish"],"Resource":"$TOPIC_ARN"},
 {"Sid":"SESPublish","Effect":"Allow","Principal":{"Service":"ses.amazonaws.com"},"Action":"SNS:Publish","Resource":"$TOPIC_ARN",
  "Condition":{"StringEquals":{"aws:SourceAccount":"$ACCOUNT"}}}]}
JSON
)"

    local dlq_url queue_url
    dlq_url=$(aws sqs get-queue-url --queue-name "$NAME-dlq" --query QueueUrl --output text 2>/dev/null || true)
    if [[ -n "$dlq_url" ]]; then
        have "dead-letter queue $NAME-dlq"
    else
        doing "create dead-letter queue $NAME-dlq (14-day retention)"
        if [[ "$MODE" == "apply" ]]; then
            dlq_url=$(aws sqs create-queue --queue-name "$NAME-dlq" \
                --attributes MessageRetentionPeriod=1209600 --query QueueUrl --output text)
        fi
    fi
    queue_url=$(aws sqs get-queue-url --queue-name "$NAME" --query QueueUrl --output text 2>/dev/null || true)
    if [[ -n "$queue_url" ]]; then
        have "queue $queue_url"
    else
        doing "create queue $NAME (visibility 120s, retention 14d, DLQ after 5 receives)"
        if [[ "$MODE" == "apply" ]]; then
            queue_url=$(aws sqs create-queue --queue-name "$NAME" --query QueueUrl --output text)
        fi
    fi
    QUEUE_URL="$queue_url"
    doing "set queue attributes + policy: topic may send"
    if [[ "$MODE" == "apply" ]]; then
        local policy redrive
        policy=$(cat <<JSON
{"Version":"2012-10-17","Statement":[{"Sid":"SNSSend","Effect":"Allow","Principal":{"Service":"sns.amazonaws.com"},
  "Action":"sqs:SendMessage","Resource":"$QUEUE_ARN","Condition":{"ArnEquals":{"aws:SourceArn":"$TOPIC_ARN"}}}]}
JSON
)
        redrive="{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"5\"}"
        aws sqs set-queue-attributes --queue-url "$QUEUE_URL" --attributes "$(python3 -c '
import json,sys; print(json.dumps({"VisibilityTimeout":"120","MessageRetentionPeriod":"1209600",
 "ReceiveMessageWaitTimeSeconds":"20","Policy":sys.argv[1],"RedrivePolicy":sys.argv[2]}))' "$policy" "$redrive")"
        local sub
        sub=$(aws sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" --query "Subscriptions[?Endpoint=='$QUEUE_ARN'].SubscriptionArn" --output text)
        if [[ -z "$sub" || "$sub" == "None" ]]; then
            aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol sqs --notification-endpoint "$QUEUE_ARN" \
                --attributes RawMessageDelivery=true --return-subscription-arn >/dev/null
        fi
    fi
    return 0
}

# ---------- 4. receipt rule ----
ensure_receipt_rule() {
    bold "4. SES receipt rule for $MAIL_DOMAIN"
    local active
    active=$(aws ses describe-active-receipt-rule-set --query 'Metadata.Name' --output text 2>/dev/null || echo None)
    if [[ "$active" != "None" && -n "$active" ]]; then
        have "active receipt rule set is '$active'; the rule is added there (never replacing an active set)"
        RULESET="$active"
    else
        if aws ses describe-receipt-rule-set --rule-set-name "$RULESET" >/dev/null 2>&1; then
            have "rule set $RULESET exists (inactive)"
        else
            doing "create rule set $RULESET"
            apply aws ses create-receipt-rule-set --rule-set-name "$RULESET"
        fi
        doing "activate rule set $RULESET"
        apply aws ses set-active-receipt-rule-set --rule-set-name "$RULESET"
    fi
    local rule
    rule=$(cat <<JSON
{"Name":"$NAME","Enabled":true,"ScanEnabled":true,"TlsPolicy":"Optional","Recipients":["$MAIL_DOMAIN"],
 "Actions":[{"S3Action":{"BucketName":"$BUCKET","ObjectKeyPrefix":"$PREFIX","TopicArn":"$TOPIC_ARN"}}]}
JSON
)
    if aws ses describe-receipt-rule --rule-set-name "$RULESET" --rule-name "$NAME" >/dev/null 2>&1; then
        doing "update rule $NAME in $RULESET"
        apply aws ses update-receipt-rule --rule-set-name "$RULESET" --rule "$rule"
    else
        doing "create rule $NAME in $RULESET: $MAIL_DOMAIN → s3://$BUCKET/$PREFIX + topic"
        apply aws ses create-receipt-rule --rule-set-name "$RULESET" --rule "$rule"
    fi
    return 0
}

# ---------- 5. configuration set --
# ---------- 5. identity feedback ----
ensure_identity_feedback() {
    bold "5. SES identity feedback (bounce/complaint notifications → topic, feedback emails off)"
    # By default SES also *emails* a Delivery Status Notification for every
    # bounce to the message's From. For relayed mail that is the list
    # address, so the DSN comes back through the receipt rule looking like a
    # post from MAILER-DAEMON (the relay drops it, but it is noise and once
    # ended up in quarantine). Forwarding can only be switched off once the
    # identity has SNS topics for both bounces and complaints, which only the
    # v1 API sets. Those notifications replace the configuration set's
    # BOUNCE/COMPLAINT events (step 6) so each bounce is recorded once.
    local kind current
    for kind in Bounce Complaint; do
        current=$(aws ses get-identity-notification-attributes --identities "$MAIL_DOMAIN" \
            --query "NotificationAttributes.\"$MAIL_DOMAIN\".${kind}Topic" --output text 2>/dev/null || echo None)
        if [[ "$current" == "$TOPIC_ARN" ]]; then
            have "$kind notifications → topic"
        else
            doing "send $kind notifications to the topic"
            apply aws ses set-identity-notification-topic --identity "$MAIL_DOMAIN" \
                --notification-type "$kind" --sns-topic "$TOPIC_ARN"
        fi
    done
    current=$(aws ses get-identity-notification-attributes --identities "$MAIL_DOMAIN" \
        --query "NotificationAttributes.\"$MAIL_DOMAIN\".ForwardingEnabled" --output text 2>/dev/null || echo True)
    if [[ "$current" == "False" ]]; then
        have "feedback emails off"
    else
        doing "turn feedback emails off"
        apply aws sesv2 put-email-identity-feedback-attributes --email-identity "$MAIL_DOMAIN" \
            --no-email-forwarding-enabled
    fi
    return 0
}

# ---------- 6. configuration set ----
ensure_configuration_set() {
    bold "6. SES configuration set $NAME (rejects → topic)"
    if aws sesv2 get-configuration-set --configuration-set-name "$NAME" >/dev/null 2>&1; then
        have "configuration set exists"
    else
        doing "create configuration set"
        apply aws sesv2 create-configuration-set --configuration-set-name "$NAME" >/dev/null
    fi
    # Bounces and complaints arrive as identity notifications (step 5);
    # listing them here too would record every bounce twice.
    local dest="{\"Enabled\":true,\"MatchingEventTypes\":[\"REJECT\"],\"SnsDestination\":{\"TopicArn\":\"$TOPIC_ARN\"}}"
    # A set with no destinations omits the key; the CLI then prints "None",
    # which is why this compares the name rather than grepping for any output.
    local existing
    existing=$(aws sesv2 get-configuration-set-event-destinations --configuration-set-name "$NAME" \
        --query "EventDestinations[?Name=='$NAME-events'].Name | [0]" --output text 2>/dev/null || true)
    if [[ -n "$existing" && "$existing" != "None" ]]; then
        doing "update event destination"
        apply aws sesv2 update-configuration-set-event-destination --configuration-set-name "$NAME" \
            --event-destination-name "$NAME-events" --event-destination "$dest" >/dev/null
    else
        doing "create event destination → topic"
        apply aws sesv2 create-configuration-set-event-destination --configuration-set-name "$NAME" \
            --event-destination-name "$NAME-events" --event-destination "$dest" >/dev/null
    fi
    return 0
}

# ---------- 6. IAM policy ---
ensure_iam() {
    bold "7. IAM policy $POLICY_NAME on role $ROLE"
    local doc arn
    doc=$(cat <<JSON
{"Version":"2012-10-17","Statement":[
 {"Sid":"Queue","Effect":"Allow","Action":["sqs:ReceiveMessage","sqs:DeleteMessage","sqs:GetQueueAttributes","sqs:ChangeMessageVisibility"],"Resource":"$QUEUE_ARN"},
 {"Sid":"Inbound","Effect":"Allow","Action":["s3:GetObject"],"Resource":"arn:aws:s3:::$BUCKET/$PREFIX*"},
 {"Sid":"Send","Effect":"Allow","Action":["ses:SendEmail","ses:SendRawEmail"],"Resource":["$IDENTITY_ARN","$CONFIGSET_ARN"]}]}
JSON
)
    arn="arn:aws:iam::$ACCOUNT:policy/$POLICY_NAME"
    if aws iam get-policy --policy-arn "$arn" >/dev/null 2>&1; then
        doing "publish a new default version of $POLICY_NAME (pruning the oldest if at the 5-version limit)"
        if [[ "$MODE" == "apply" ]]; then
            local count oldest
            count=$(aws iam list-policy-versions --policy-arn "$arn" --query 'length(Versions)' --output text)
            if [[ "$count" -ge 5 ]]; then
                oldest=$(aws iam list-policy-versions --policy-arn "$arn" --query "Versions[?IsDefaultVersion==\`false\`] | sort_by(@, &CreateDate)[0].VersionId" --output text)
                aws iam delete-policy-version --policy-arn "$arn" --version-id "$oldest"
            fi
            aws iam create-policy-version --policy-arn "$arn" --policy-document "$doc" --set-as-default >/dev/null
        fi
    else
        doing "create policy $POLICY_NAME"
        apply aws iam create-policy --policy-name "$POLICY_NAME" --policy-document "$doc" >/dev/null
    fi
    local attached
    attached=$(aws iam list-attached-role-policies --role-name "$ROLE" \
        --query "AttachedPolicies[?PolicyName=='$POLICY_NAME'].PolicyName | [0]" --output text 2>/dev/null || true)
    if [[ -n "$attached" && "$attached" != "None" ]]; then
        have "attached to $ROLE"
    else
        doing "attach to role $ROLE"
        apply aws iam attach-role-policy --role-name "$ROLE" --policy-arn "$arn"
    fi
    return 0
}

# ---------- status -----
print_status() {
    bold "Identity"
    aws sesv2 get-email-identity --email-identity "$MAIL_DOMAIN" \
        --query '{Verified:VerifiedForSendingStatus,DkimStatus:DkimAttributes.Status,MailFrom:MailFromAttributes.MailFromDomain,MailFromStatus:MailFromAttributes.MailFromDomainStatus,FeedbackEmails:FeedbackForwardingStatus}' \
        --output table 2>/dev/null || note "identity not created yet"
    aws ses get-identity-notification-attributes --identities "$MAIL_DOMAIN" \
        --query "NotificationAttributes.\"$MAIL_DOMAIN\".{BounceTopic:BounceTopic,ComplaintTopic:ComplaintTopic}" \
        --output table 2>/dev/null || true
    local tokens
    tokens=$(aws sesv2 get-email-identity --email-identity "$MAIL_DOMAIN" --query 'DkimAttributes.Tokens' --output text 2>/dev/null || true)
    bold "DNS records to publish for $MAIL_DOMAIN (at the registrar that hosts the zone)"
    note "MX   $MAIL_DOMAIN                  10 inbound-smtp.$REGION.amazonaws.com."
    for t in $tokens; do
        [[ "$t" == "None" ]] && continue
        note "CNAME ${t}._domainkey.$MAIL_DOMAIN   ${t}.dkim.amazonses.com."
    done
    note "MX   $MAIL_FROM_DOMAIN           10 feedback-smtp.$REGION.amazonses.com."
    note "TXT  $MAIL_FROM_DOMAIN           \"v=spf1 include:amazonses.com ~all\""
    note "TXT  _dmarc.$MAIL_DOMAIN         \"v=DMARC1; p=quarantine${DMARC_RUA:+; rua=$DMARC_RUA}\"   (optional but recommended)"
    bold "Receipt rule"
    aws ses describe-active-receipt-rule-set --query 'Metadata.Name' --output text 2>/dev/null | sed 's/^/  active rule set: /'
    bold "Queue"
    local q
    q=$(aws sqs get-queue-url --queue-name "$NAME" --query QueueUrl --output text 2>/dev/null || echo "(not created)")
    note "$q"
    [[ "$q" != "(not created)" ]] && aws sqs get-queue-attributes --queue-url "$q" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible --output table
    bold "Env lines for /etc/breakside/env (record the values in the private ops repo)"
    note "BREAKSIDE_MAIL_TRANSPORT=ses"
    note "BREAKSIDE_MAIL_DOMAIN=$MAIL_DOMAIN"
    note "BREAKSIDE_MAIL_REGION=$REGION"
    note "BREAKSIDE_MAIL_INBOUND_BUCKET=${BUCKET:-<bucket>}"
    note "BREAKSIDE_MAIL_QUEUE_URL=${q}"
    note "BREAKSIDE_MAIL_CONFIGURATION_SET=$NAME"
    bold "Then on the box: pip install from requirements.lock (boto3 is new), deploy, and watch"
    note "journalctl -u breakside -f | grep 'mail:'"
}

if [[ "$MODE" == "status" ]]; then
    [[ -n "$BUCKET" ]] || BUCKET=$(aws resourcegroupstaggingapi get-resources --resource-type-filters s3 \
        --tag-filters Key=breakside,Values=team-mail --query 'ResourceTagMappingList[0].ResourceARN' --output text 2>/dev/null | sed 's#arn:aws:s3:::##; s#^None$##')
    print_status
    exit 0
fi

ensure_identity
ensure_bucket
ensure_topic_and_queues
ensure_receipt_rule
ensure_identity_feedback
ensure_configuration_set
ensure_iam
echo
if [[ "$MODE" == "plan" ]]; then
    bold "plan complete — nothing was changed. Run with 'apply' to create."
else
    print_status
fi
