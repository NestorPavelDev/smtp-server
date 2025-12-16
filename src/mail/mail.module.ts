import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { MailService } from "./mail.service";
import { GmailApiPollingService } from "./gmail-api.service";
import { OutlookGraphPollingService } from "./outlook-graph.service";

@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [
    MailService,
    // GmailApiPollingService,
    OutlookGraphPollingService,
  ],
})
export class MailModule {}
