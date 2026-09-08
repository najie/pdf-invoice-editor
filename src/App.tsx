import { Dropzone } from './components/Dropzone';
import { ExportBar } from './components/ExportBar';
import { PageView } from './components/PageView';
import { EditPanel } from './components/EditPanel';
import { DiffPanel } from './components/DiffPanel';
import { useStore } from './state/store';

export default function App() {
  const status = useStore((s) => s.status);
  const pages = useStore((s) => s.pages);

  if (status !== 'ready') return <Dropzone />;

  return (
    <div className="flex h-full flex-col">
      <ExportBar />
      <div className="flex min-h-0 flex-1">
        <main className="flex-1 overflow-auto p-6">
          <div className="space-y-8">
            {pages.map((page) => (
              <PageView key={page.info.index} page={page} />
            ))}
          </div>
        </main>
        <aside className="flex w-80 shrink-0 flex-col border-l border-edge bg-white">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <EditPanel />
          </div>
          <DiffPanel />
        </aside>
      </div>
    </div>
  );
}
