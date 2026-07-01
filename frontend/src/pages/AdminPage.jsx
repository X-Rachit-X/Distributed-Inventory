import { useState } from 'react';
import AdminTabs from '../components/admin/AdminTabs';
import StationManager from '../components/admin/StationManager';
import TrainManager from '../components/admin/TrainManager';
import RouteManager from '../components/admin/RouteManager';
import ScheduleManager from '../components/admin/ScheduleManager';

export default function AdminPage() {
  const [tab, setTab] = useState('Stations');

  return (
    <div className="section-container py-8">
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary-600 to-primary-700 flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M9 2a3 3 0 100 6 3 3 0 000-6zM3 15a6 6 0 0112 0H3z" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          <h1 className="font-display text-2xl font-bold text-surface-900">Admin Panel</h1>
        </div>
        <p className="text-surface-500 text-sm">Manage stations, trains, routes, and schedules</p>
      </div>

      <AdminTabs active={tab} onChange={setTab} />

      <div className="mt-6">
        {tab === 'Stations'  && <StationManager />}
        {tab === 'Trains'    && <TrainManager />}
        {tab === 'Routes'    && <RouteManager />}
        {tab === 'Schedules' && <ScheduleManager />}
      </div>
    </div>
  );
}
