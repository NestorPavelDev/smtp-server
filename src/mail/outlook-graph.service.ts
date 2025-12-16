import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { CronJob } from "cron";

const CRON_JOB_NAME = "outlook-graph-poll";

type OutlookPollingConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  userId: string;
  folderId: string;
  cronExpression: string;
  top: number;
  processedCache: number;
};

type GraphMessage = {
  id?: string;
  subject?: string;
  from?: {
    emailAddress?: {
      name?: string;
      address?: string;
    };
  };
};

@Injectable()
export class OutlookGraphPollingService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(OutlookGraphPollingService.name);
  private config?: OutlookPollingConfig;
  private cronJob?: CronJob;

  private readonly processedQueue: string[] = [];
  private readonly processedSet = new Set<string>();

  private accessToken?: string;
  private accessTokenExpiresAtMs = 0;

  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry
  ) {}

  async onModuleInit() {
    if (!this.isEnabled()) {
      this.logger.log("Outlook Graph polling disabled.");
      return;
    }

    try {
      this.config = this.resolveConfig();
      this.registerCronJob(this.config.cronExpression);
      this.logger.log(
        `Outlook Graph poller ready (cron: ${this.config.cronExpression}).`
      );
    } catch (err) {
      this.logger.error(
        "Failed to initialize Outlook Graph poller",
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
    const raw = this.configService.get<string>("OUTLOOK_API_ENABLED");
    return (raw ?? "").trim().toLowerCase() === "true";
  }

  private resolveConfig(): OutlookPollingConfig {
    const tenantId = this.requireEnv("OUTLOOK_TENANT_ID");
    const clientId = this.requireEnv("OUTLOOK_CLIENT_ID");
    const clientSecret = this.requireEnv("OUTLOOK_CLIENT_SECRET");

    // For app-only auth you must use /users/{id|userPrincipalName}
    const userId = this.requireEnv("OUTLOOK_USER_ID");

    const folderId = this.configService.get<string>(
      "OUTLOOK_FOLDER_ID",
      "inbox"
    );

    const cronExpression = this.configService.get<string>(
      "OUTLOOK_CRON_EXPRESSION",
      "*/5 * * * *"
    );

    const top = Number(this.configService.get("OUTLOOK_TOP", 10));
    const processedCache = Number(
      this.configService.get("OUTLOOK_PROCESSED_CACHE", 100)
    );

    return {
      tenantId,
      clientId,
      clientSecret,
      userId,
      folderId,
      cronExpression,
      top,
      processedCache,
    };
  }

  private registerCronJob(expression: string) {
    const job = new CronJob(expression, () => {
      this.pollInbox().catch((err) =>
        this.logger.error(
          "Outlook Graph poll failed",
          err.stack || err.message || String(err)
        )
      );
    });

    this.schedulerRegistry.addCronJob(CRON_JOB_NAME, job);
    job.start();
    this.cronJob = job;
  }

  private async pollInbox() {
    if (!this.config) {
      return;
    }

    const messages = await this.listUnreadMessages(this.config);
    if (messages.length === 0) {
      this.logger.debug("Outlook Graph poll: no matching messages");
      return;
    }

    for (const message of messages) {
      const id = message.id;
      if (!id || this.processedSet.has(id)) {
        continue;
      }

      this.logMessage(message);
      this.trackProcessed(id);
    }
  }

  private logMessage(message: GraphMessage) {
    const subject = message.subject || "(no subject)";

    const fromName = message.from?.emailAddress?.name;
    const fromAddress = message.from?.emailAddress?.address;
    const from = fromName || fromAddress || "unknown sender";

    this.logger.log(
      `Outlook Graph detected message ${message.id} from ${from} with subject "${subject}".`
    );
  }

  private async listUnreadMessages(
    config: OutlookPollingConfig
  ): Promise<GraphMessage[]> {
    const token = await this.getAccessToken(config);

    const url = new URL(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(
        config.userId
      )}/mailFolders/${encodeURIComponent(config.folderId)}/messages`
    );

    url.searchParams.set("$top", String(config.top));
    url.searchParams.set("$orderby", "receivedDateTime desc");
    url.searchParams.set("$select", "id,subject,from,receivedDateTime");
    url.searchParams.set("$filter", "isRead eq false");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(
        `Graph list messages failed (${response.status}): ${bodyText}`
      );
    }

    const body = JSON.parse(bodyText) as { value?: GraphMessage[] };
    return body.value ?? [];
  }

  private async getAccessToken(config: OutlookPollingConfig): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.accessTokenExpiresAtMs - 30_000) {
      return this.accessToken;
    }

    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(
      config.tenantId
    )}/oauth2/v2.0/token`;

    const form = new URLSearchParams();
    form.set("client_id", config.clientId);
    form.set("client_secret", config.clientSecret);
    form.set("grant_type", "client_credentials");
    form.set("scope", "https://graph.microsoft.com/.default");

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(
        `Graph token request failed (${response.status}): ${bodyText}`
      );
    }

    const body = JSON.parse(bodyText) as {
      access_token?: string;
      expires_in?: number;
      token_type?: string;
    };

    const accessToken = body.access_token;
    if (!accessToken) {
      throw new Error("Graph token response missing access_token");
    }

    const expiresInSec =
      typeof body.expires_in === "number" ? body.expires_in : 3600;
    this.accessToken = accessToken;
    this.accessTokenExpiresAtMs = Date.now() + expiresInSec * 1000;

    return accessToken;
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
