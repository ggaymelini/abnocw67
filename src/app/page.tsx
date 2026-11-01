import Link from 'next/link';
import Simulator from '@/components/sim/simulator';

export default function Home() {
  return (
    <div>
      <Simulator />
      <Link
        href="/online"
        className="fixed bottom-3 right-3 z-50 rounded-lg border border-zinc-600 bg-zinc-800/90 px-3 py-2 text-sm font-semibold text-zinc-200 shadow-lg backdrop-blur hover:bg-zinc-700"
      >
        🌐 Сетевой бой
      </Link>
    </div>
  );
}
