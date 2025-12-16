import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { google, gmail_v1 } from "googleapis";
import { CronJob } from "cron";

const CRON_JOB_NAME = "gmail-api-poll";

type GmailPollingConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  refreshToken: string;
  cronExpression: string;
  query: string;
  labelIds: string[];
  maxResults: number;
  processedCache: number;
};

@Injectable()
export class GmailApiPollingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GmailApiPollingService.name);
  private gmail?: gmail_v1.Gmail;
  private config?: GmailPollingConfig;
  private cronJob?: CronJob;
  private readonly processedQueue: string[] = [];
  private readonly processedSet = new Set<string>();

  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry
  ) {}

  async onModuleInit() {
    if (!this.isEnabled()) {
      this.logger.log(
        "Gmail API polling disabled. Set GMAIL_API_ENABLED=true to enable."
      );
      return;
    }

    try {
      this.config = this.resolveConfig();
      this.gmail = this.createGmailClient(this.config);
      this.registerCronJob(this.config.cronExpression);
      this.logger.log(
        `Gmail API poller ready (cron: ${this.config.cronExpression}).`
      );
    } catch (err) {
      this.logger.error(
        "Failed to initialize Gmail API poller",
        (err as Error).stack || (err as Error).message
      );
    }
  }

  async onModuleDestroy() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.schedulerRegistry.deleteCronJob(CRON_JOB_NAME);
    }
  }

  private isEnabled(): boolean {
    const raw = this.configService.get<string>("GMAIL_API_ENABLED");
    return (raw ?? "").trim().toLowerCase() === "true";
  }

  private resolveConfig(): GmailPollingConfig {
    const clientId = this.requireEnv("GOOGLE_CLIENT_ID");
    const clientSecret = this.requireEnv("GOOGLE_CLIENT_SECRET");
    const refreshToken = this.requireEnv("GOOGLE_REFRESH_TOKEN");
    const redirectUri = this.configService.get<string>(
      "GOOGLE_REDIRECT_URI",
      "https://developers.google.com/oauthplayground"
    );

    const cronExpression = this.configService.get<string>(
      "GMAIL_CRON_EXPRESSION",
      "*/5 * * * *"
    );

    const labels = this.configService
      .get<string>("GMAIL_LABELS", "INBOX,UNREAD")
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean);

    const maxResults = Number(this.configService.get("GMAIL_MAX_RESULTS", 10));
    const processedCache = Number(
      this.configService.get("GMAIL_PROCESSED_CACHE", 100)
    );
    const query = this.configService.get<string>(
      "GMAIL_QUERY",
      "is:unread newer_than:1d"
    );

    return {
      clientId,
      clientSecret,
      refreshToken,
      redirectUri,
      cronExpression,
      query,
      labelIds: labels,
      maxResults,
      processedCache,
    };
  }

  private createGmailClient(config: GmailPollingConfig): gmail_v1.Gmail {
    const oauth2Client = new google.auth.OAuth2(
      config.clientId,
      config.clientSecret,
      config.redirectUri
    );
    oauth2Client.setCredentials({ refresh_token: config.refreshToken });

    return google.gmail({ version: "v1", auth: oauth2Client });
  }

  private registerCronJob(expression: string) {
    const job = new CronJob(expression, () => {
      this.pollInbox().catch((err) =>
        this.logger.error(
          "Gmail API poll failed",
          err.stack || err.message || String(err)
        )
      );
    });

    this.schedulerRegistry.addCronJob(CRON_JOB_NAME, job);
    job.start();
    this.cronJob = job;
  }

  private async pollInbox() {
    if (!this.gmail || !this.config) {
      return;
    }

    const response = await this.gmail.users.messages.list({
      userId: "me",
      labelIds: this.config.labelIds,
      q: this.config.query,
      maxResults: this.config.maxResults,
    });

    const messages = response.data.messages ?? [];
    if (messages.length === 0) {
      this.logger.debug("Gmail API poll: no matching messages");
      return;
    }

    for (const entry of messages) {
      if (!entry.id || this.processedSet.has(entry.id)) {
        continue;
      }

      await this.inspectMessage(entry.id);
      this.trackProcessed(entry.id);
    }
  }

  private async inspectMessage(id: string) {
    if (!this.gmail) {
      return;
    }

    const result = await this.gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["Subject", "From"],
    });

    const headers = this.asHeaderMap(result.data.payload?.headers);
    const subject = headers.get("subject") || "(no subject)";
    const from = headers.get("from") || "unknown sender";

    this.logger.log(
      `Gmail API detected message ${id} from ${from} with subject "${subject}".`
    );
  }

  private asHeaderMap(
    headers?: gmail_v1.Schema$MessagePartHeader[] | null
  ): Map<string, string> {
    const map = new Map<string, string>();
    headers?.forEach((header) => {
      const name = header.name?.toLowerCase();
      const value = header.value;
      if (name && value) {
        map.set(name, value);
      }
    });
    return map;
  }

  private trackProcessed(id: string) {
    if (!this.config || this.processedSet.has(id)) {
      return;
    }

    this.processedSet.add(id);
    this.processedQueue.push(id);

    while (this.processedQueue.length > this.config.processedCache) {
      const oldest = this.processedQueue.shift();
      if (oldest) {
        this.processedSet.delete(oldest);
      }
    }
  }

  private requireEnv(key: string): string {
    const value = this.configService.get<string>(key);
    if (!value) {
      throw new Error(`Missing required environment variable ${key}`);
    }
    return value;
  }
}
