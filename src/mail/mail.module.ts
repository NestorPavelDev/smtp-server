import { Module } from "@nestjs/common";
import { MailService } from "./mail.service";
import { GmailApiPollingService } from "./gmail-api.service";

@Module({
  providers: [MailService, GmailApiPollingService],
})
export class MailModule {}
