# Slack Integration — Setup

The Daily Briefing pulls Slack mentions via a **live callout** to Slack's Web API
(`search.messages`) using a **Named Credential** named `Slack`. Salesforce stores no
Slack message data natively, so this is the only way to surface real mentions.

## What's already deployed
- **External Credential** `Slack` (Custom auth protocol, with a `SlackPrincipal` named principal
  and an `Authorization: Bearer {!$Credential.Slack.Token}` auth header)
- **Permission Set** `Slack Briefing Access` (grants access to the `Slack-SlackPrincipal` principal)
- Apex `getSlackMessages()` — fully written, gated behind `ENABLE_SLACK = false`

## What you finish (one-time, ~10 min)

### 1. Create the Slack app + token
1. https://api.slack.com/apps → **Create New App** → From scratch
2. **OAuth & Permissions** → add **User Token Scope**: `search:read`
   (search.messages runs *as the user*, so it must be a **user token**, not a bot token)
3. **Install to Workspace** → copy the **User OAuth Token** (`xoxp-…`)

### 2. Create the Named Credential (UI — the metadata version is unreliable)
Setup → **Named Credentials** → **New**:
- Label / Name: **Slack**
- URL: **https://slack.com**
- External Credential: **Slack** (the one already deployed)
- Save

> A reference metadata file is saved as `Slack.namedCredential-meta.xml.reference` in this
> folder if you ever want to script it, but UI creation is the reliable path.

### 3. Store the token on the principal
Setup → **External Credentials** → **Slack** → **Principals** → edit **SlackPrincipal** →
**Add** an Authentication Parameter:
- Name: **Token**
- Value: your `xoxp-…` user token
- Save  (this is why the auth header is `Bearer {!$Credential.Slack.Token}`)

### 4. Grant access
Assign the **Slack Briefing Access** permission set to the users who should get Slack mentions
(or add the external-credential principal access to an existing permission set they already have).

### 5. Turn it on
In `DailyBriefingController`, flip:
```apex
@TestVisible private static Boolean ENABLE_SLACK = true;
```
Deploy the class. Done — the Slack section now populates from live mentions.

## Notes
- If the callout fails for any reason (token expired, no access), `getSlackMessages()` returns
  `[]` and the Slack section simply doesn't render — no errors shown to the rep.
- `search.messages` query is `has:@me` (messages mentioning the running user). Adjust in Apex
  if you want a different filter (e.g. a specific channel).
- The running user's Salesforce identity ↔ Slack identity: because this uses a single named
  principal token, all briefings search as *that* token's user. For true per-rep mentions,
  switch the External Credential to a **Per-User** principal and have each rep authorize Slack.
