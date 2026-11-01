import type { Metadata } from 'next';
import OnlineClient from '@/components/online/online-client';

export const metadata: Metadata = {
  title: 'Сетевой бой — симулятор',
  description: 'Кооперативный PvP-бой на авторитетном сервере: комнаты по коду, до 4 игроков.',
};

export default function OnlinePage() {
  return <OnlineClient />;
}
