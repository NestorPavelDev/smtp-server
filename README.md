# smtp-server
SMTP server

NestJS application that can:

- Watch a mailbox via IMAP (`MailService`) and send notification emails via SMTP.
- Poll Gmail via Gmail API on a cron schedule (`GmailApiPollingService`).
- Poll Outlook/Microsoft 365 via Microsoft Graph on a cron schedule (`OutlookGraphPollingService`).

## Run

- Install: `npm install`
- Dev: `npm run start:dev`
- Build: `npm run build`
- Prod: `npm run start:prod`

Copy `.env.example` to `.env` and fill in the values you need.

## Gmail API polling

Enable with `GMAIL_API_ENABLED=true` and set:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`

Cron schedule is controlled by `GMAIL_CRON_EXPRESSION`.

## Outlook / Microsoft 365 (Graph) polling

Enable with `OUTLOOK_API_ENABLED=true` and set the app-only OAuth settings:

- `OUTLOOK_TENANT_ID`
- `OUTLOOK_CLIENT_ID`
- `OUTLOOK_CLIENT_SECRET`
- `OUTLOOK_USER_ID` (user principal name / email like `user@contoso.com` or the user object id)

The poller uses Microsoft Graph `client_credentials` flow and reads unread messages from the configured folder (`OUTLOOK_FOLDER_ID`, default `inbox`).

Required Microsoft Graph permissions (Azure App Registration):

- `Mail.Read` (Application permission)
- Admin consent for the tenant

Cron schedule is controlled by `OUTLOOK_CRON_EXPRESSION`.
