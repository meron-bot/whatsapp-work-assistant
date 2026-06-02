import { Injectable } from '@nestjs/common';
import { google } from 'googleapis';
import { GoogleAuthService } from './google-auth.service';

@Injectable()
export class GoogleDocsService {
  constructor(private readonly auth: GoogleAuthService) {}

  private async docsApi() {
    const client = await this.auth.getAuthorizedClient();
    return google.docs({ version: 'v1', auth: client });
  }

  private async driveApi() {
    const client = await this.auth.getAuthorizedClient();
    return google.drive({ version: 'v3', auth: client });
  }

  /** Create a Google Doc with plain-text content. Returns id + share URL. */
  async createDocument(
    title: string,
    content: string,
    folderId?: string | null,
  ): Promise<{ id: string; url: string }> {
    const docs = await this.docsApi();
    const created = await docs.documents.create({ requestBody: { title } });
    const docId = created.data.documentId ?? '';

    if (content) {
      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: {
          requests: [{ insertText: { location: { index: 1 }, text: content } }],
        },
      });
    }

    if (folderId) {
      const drive = await this.driveApi();
      await drive.files.update({ fileId: docId, addParents: folderId, fields: 'id' });
    }

    return { id: docId, url: `https://docs.google.com/document/d/${docId}/edit` };
  }
}
