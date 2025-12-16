import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FetchMessageObject, ImapFlow, MessageEnvelopeObject } from "imapflow";
import * as nodemailer from "nodemailer";
import { Transporter } from "nodemailer";

type MailWatcherConfig = {
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPass: string;
  mailbox: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  notifyRecipient: string;
  notifyFrom: string;
};

@Injectable()
export class MailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  private imapClient?: ImapFlow;
  private smtpTransport?: Transporter;
  private shuttingDown = false;
  private lastProcessedUid = 0;
  private processingMailbox = false;

  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService
  ) {}

  async onModuleInit() {
    if (!this.isEnabled()) {
      this.logger.log(
        "MailService disabled."
      );
      return;
    }

    const watcherConfig = this.resolveConfig();

    await this.bootstrapSmtpTransport(watcherConfig);

    try {
      await this.startImapWatcher(watcherConfig);
    } catch (err) {
      this.logger.error(
        "Failed to start IMAP watcher",
        err.stack || err.message
      );
      throw err;
    }
  }

  async onModuleDestroy() {
    this.shuttingDown = true;
    if (this.imapClient) {
      await this.imapClient
        .logout()
        .catch((err) =>
          this.logger.error(
            "Failed to close IMAP connection",
            err.stack || err.message
          )
        );
    }
    if (this.smtpTransport) {
      await this.smtpTransport.close();
    }
  }

  private resolveConfig(): MailWatcherConfig {
    const imapUser = this.requireEnv("SOURCE_EMAIL");
    const imapPass = this.requireEnv("SOURCE_APP_PASSWORD");
    const notifyRecipient = this.requireEnv("NOTIFY_RECIPIENT");

    const imapHost = this.configService.get<string>(
      "IMAP_HOST",
      "imap.gmail.com"
    );
    const imapPort = Number(this.configService.get("IMAP_PORT", 993));
    const smtpHost = this.configService.get<string>(
      "SMTP_HOST",
      "smtp.gmail.com"
    );
    const smtpPort = Number(this.configService.get("SMTP_PORT", 465));
    const smtpSecure =
      this.configService.get<string>("SMTP_SECURE", "true") !== "false";
    const mailbox = this.configService.get<string>("GMAIL_MAILBOX", "INBOX");
    const notifyFrom = this.configService.get<string>(
      "NOTIFY_FROM",
      `${imapUser}`
    );

    return {
      imapHost,
      imapPort,
      imapUser,
      imapPass,
      mailbox,
      smtpHost,
      smtpPort,
      smtpSecure,
      smtpUser: this.configService.get<string>("SMTP_USERNAME", imapUser),
      smtpPass: this.configService.get<string>("SMTP_PASSWORD", imapPass),
      notifyRecipient,
      notifyFrom,
    };
  }

  private requireEnv(key: string): string {
    const value = this.configService.get<string>(key);
    if (!value) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
  }

  private async bootstrapSmtpTransport(config: MailWatcherConfig) {
    this.smtpTransport = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: config.smtpUser,
        pass: config.smtpPass,
      },
    });

    await this.smtpTransport.verify().catch((err) => {
      this.logger.error(`SMTP verify failed: ${err.message}`);
      throw err;
    });

    this.logger.log(
      `SMTP transport ready (${config.smtpHost}:${config.smtpPort})`
    );
  }

  private async startImapWatcher(config: MailWatcherConfig) {
    this.imapClient = new ImapFlow({
      host: config.imapHost,
      port: config.imapPort,
      secure: true,
      auth: {
        user: config.imapUser,
        pass: config.imapPass,
      },
      logger: false,
    });

    this.imapClient.on("error", (err) => {
      if (this.shuttingDown) {
        return;
      }
      this.logger.error(`IMAP error: ${err.message}`);
    });

    await this.imapClient.connect();

    const mailboxInfo = await this.imapClient.mailboxOpen(config.mailbox);
    this.lastProcessedUid = mailboxInfo.uidNext ? mailboxInfo.uidNext - 1 : 0;
    this.logger.log(`Watching mailbox ${config.mailbox}`);

    this.imapClient.on("exists", async () => {
      if (this.processingMailbox) {
        return;
      }
      this.processingMailbox = true;
      await this.handleNewMessages(config).catch((err) =>
        this.logger.error(
          "Failed to process new message",
          err.stack || err.message
        )
      );
      this.processingMailbox = false;
    });
  }

  private async handleNewMessages(config: MailWatcherConfig) {
    if (!this.imapClient) {
      return;
    }

    const mailbox = this.imapClient.mailbox;
    if (!mailbox) {
      return;
    }

    const startUid = this.lastProcessedUid + 1;
    if (!mailbox.exists || startUid > (mailbox.uidNext || 0)) {
      return;
    }

    const fetchOptions = { envelope: true, uid: true } as const;
    const iterator = this.imapClient.fetch(
      { uid: `${startUid}:*` },
      fetchOptions
    ) as AsyncIterableIterator<FetchMessageObject>;

    for await (const message of iterator) {
      if (
        !message.envelope ||
        !message.uid ||
        message.uid <= this.lastProcessedUid
      ) {
        continue;
      }

      await this.sendNotification(config, message.envelope);
      this.lastProcessedUid = message.uid;
    }
  }

  private async sendNotification(
    config: MailWatcherConfig,
    envelope?: MessageEnvelopeObject
  ) {
    if (!this.smtpTransport) {
      throw new Error("SMTP transport is not ready");
    }

    const sender = envelope?.from?.[0];
    const fromDisplay = sender?.name || sender?.address || "unknown sender";
    const subject = envelope?.subject || "(no subject)";

    this.logger.log(`Forwarding notification for message from ${fromDisplay}`);

    await this.smtpTransport.sendMail({
      from: config.notifyFrom,
      to: config.notifyRecipient,
      subject: `New email received from ${fromDisplay}`,
      text: `You have received a new email from ${fromDisplay} with the subject "${subject}".`,
    });
  }

  private isEnabled(): boolean {
    const raw = this.configService.get<string>("MAIL_SERVICE_ENABLED");
    return (raw ?? "").trim().toLowerCase() === "true";
  }
}
