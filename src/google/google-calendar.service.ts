import { Injectable } from '@nestjs/common';
import { google } from 'googleapis';
import { env } from '../config/env';
import { GoogleAuthService } from './google-auth.service';

export interface FreeBusySlot {
  start: string;
  end: string;
}

export interface CreateEventInput {
  title: string;
  description?: string | null;
  startTime: string;
  endTime: string;
  attendees?: string[];
  /** Attach a Google Meet link. Defaults to true when there are attendees. */
  addMeet?: boolean;
}

@Injectable()
export class GoogleCalendarService {
  constructor(private readonly auth: GoogleAuthService) {}

  private async api() {
    const client = await this.auth.getAuthorizedClient();
    return google.calendar({ version: 'v3', auth: client });
  }

  async checkFreeBusy(timeMin: string, timeMax: string): Promise<FreeBusySlot[]> {
    const calendar = await this.api();
    const res = await calendar.freebusy.query({
      requestBody: { timeMin, timeMax, items: [{ id: 'primary' }], timeZone: env().OWNER_TIMEZONE },
    });
    return (res.data.calendars?.primary?.busy ?? []).map((b) => ({
      start: b.start ?? '',
      end: b.end ?? '',
    }));
  }

  async listUpcoming(maxResults = 10) {
    const calendar = await this.api();
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    });
    return res.data.items ?? [];
  }

  async listForDay(date: Date) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);
    const calendar = await this.api();
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });
    return res.data.items ?? [];
  }

  async createEvent(
    input: CreateEventInput,
  ): Promise<{ id: string; htmlLink: string; meetLink: string | null }> {
    const calendar = await this.api();
    const addMeet = input.addMeet ?? (input.attendees?.length ?? 0) > 0;
    const res = await calendar.events.insert({
      calendarId: 'primary',
      sendUpdates: input.attendees?.length ? 'all' : 'none',
      conferenceDataVersion: addMeet ? 1 : 0,
      requestBody: {
        summary: input.title,
        description: input.description ?? undefined,
        start: { dateTime: input.startTime, timeZone: env().OWNER_TIMEZONE },
        end: { dateTime: input.endTime, timeZone: env().OWNER_TIMEZONE },
        attendees: input.attendees?.map((email) => ({ email })),
        conferenceData: addMeet
          ? {
              createRequest: {
                requestId: `meet-${Date.now()}`,
                conferenceSolutionKey: { type: 'hangoutsMeet' },
              },
            }
          : undefined,
      },
    });
    return {
      id: res.data.id ?? '',
      htmlLink: res.data.htmlLink ?? '',
      meetLink: res.data.hangoutLink ?? null,
    };
  }
}
