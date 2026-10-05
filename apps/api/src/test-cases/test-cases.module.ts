import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { TestCasesController, TestCasesLibraryController } from "./test-cases.controller";
import { TestCasesService } from "./test-cases.service";

@Module({ imports: [AuthModule, DatabaseModule], controllers: [TestCasesController, TestCasesLibraryController], providers: [TestCasesService] })
export class TestCasesModule {}