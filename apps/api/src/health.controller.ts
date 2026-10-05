import { Controller, Get } from "@nestjs/common";

@Controller("v1/health")
export class HealthController {
  @Get()
  check() {
    return { status: "ok", service: "ai-qa-control-plane", timestamp: new Date().toISOString() };
  }
}