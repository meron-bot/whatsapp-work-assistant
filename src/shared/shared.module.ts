import { Global, Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

/**
 * Cross-cutting, low-level services used by many feature modules. Marked global
 * so feature modules can inject them without import cycles.
 */
@Global()
@Module({
  providers: [WhatsAppService, StorageService, AuditService],
  exports: [WhatsAppService, StorageService, AuditService],
})
export class SharedModule {}
