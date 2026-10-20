import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { DatabaseModule } from "../database/database.module";
import { MailService } from "../mail/mail.service";
import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";
import { AuthService } from "./auth.service";

@Module({
  imports: [
    DatabaseModule,
    JwtModule.registerAsync({ inject: [ConfigService], useFactory: (config: ConfigService) => ({ secret: config.getOrThrow<string>("JWT_SECRET"), signOptions: { expiresIn: "8h" } }) })
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, MailService],
  exports: [AuthGuard, JwtModule]
})
export class AuthModule {}