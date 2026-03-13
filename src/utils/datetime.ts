import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';

const TIMEZONE = 'Asia/Tokyo';

export function toJST(date: Date | string): Date {
  const d = typeof date === 'string' ? new Date(date) : date;
  return toZonedTime(d, TIMEZONE);
}

export function formatDateJST(date: Date | string): string {
  const jst = toJST(date);
  const month = jst.getMonth() + 1;
  const day = jst.getDate();
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const weekday = weekdays[jst.getDay()];
  return `${month}月${day}日（${weekday}）`;
}

export function formatTimeJST(date: Date | string): string {
  const jst = toJST(date);
  return format(jst, 'HH:mm');
}

export function formatDateTimeJST(date: Date | string): string {
  return `${formatDateJST(date)} ${formatTimeJST(date)}`;
}
