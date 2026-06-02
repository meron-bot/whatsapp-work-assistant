import { Injectable } from '@nestjs/common';
import { google } from 'googleapis';
import { Readable } from 'stream';
import { GoogleAuthService } from './google-auth.service';

@Injectable()
export class GoogleDriveService {
  constructor(private readonly auth: GoogleAuthService) {}

  private async api() {
    const client = await this.auth.getAuthorizedClient();
    return google.drive({ version: 'v3', auth: client });
  }

  /** Find or create a folder by name under an optional parent. */
  async ensureFolder(name: string, parentId?: string | null): Promise<string> {
    const drive = await this.api();
    const q = [
      `mimeType = 'application/vnd.google-apps.folder'`,
      `name = '${name.replace(/'/g, "\\'")}'`,
      'trashed = false',
      parentId ? `'${parentId}' in parents` : null,
    ]
      .filter(Boolean)
      .join(' and ');
    const existing = await drive.files.list({ q, fields: 'files(id,name)' });
    if (existing.data.files?.length) return existing.data.files[0].id ?? '';

    const created = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : undefined,
      },
      fields: 'id',
    });
    return created.data.id ?? '';
  }

  async uploadFile(
    name: string,
    mimeType: string,
    buffer: Buffer,
    folderId?: string | null,
  ): Promise<{ id: string; webViewLink: string }> {
    const drive = await this.api();
    const res = await drive.files.create({
      requestBody: { name, parents: folderId ? [folderId] : undefined },
      media: { mimeType, body: Readable.from(buffer) },
      fields: 'id,webViewLink',
    });
    return { id: res.data.id ?? '', webViewLink: res.data.webViewLink ?? '' };
  }
}
