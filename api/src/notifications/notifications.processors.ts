import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { NOTIFY_QUEUE, NotificationsService, NotifyJob, POLL_QUEUE } from './notifications.service';

// Тонкие обработчики очередей: логика — в NotificationsService.
// Конкурентность по умолчанию 1: проходы поллера не пересекаются, уведомления идут по порядку.

@Processor(POLL_QUEUE)
export class PollProcessor extends WorkerHost {
  constructor(private readonly notifications: NotificationsService) {
    super();
  }

  process(): Promise<void> {
    return this.notifications.pollAll();
  }
}

@Processor(NOTIFY_QUEUE)
export class NotifyProcessor extends WorkerHost {
  constructor(private readonly notifications: NotificationsService) {
    super();
  }

  process(job: Job<NotifyJob>): Promise<'sent' | 'skipped'> {
    const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    return this.notifications.deliver(job.data.transactionId, lastAttempt);
  }
}
