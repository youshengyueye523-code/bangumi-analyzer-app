import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { PRIVACY_EVENT } from './lib/userGovernance.js';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell.js';
import { MaterialProvider } from './components/layout/material.js';
import { WallpaperProvider } from './components/layout/wallpaper.js';
import { TooltipProvider } from './components/ui/overlay.js';
import { ToastProvider } from './components/ui/toast.js';
import { AnalysisPage } from './pages/AnalysisPage.js';
import { DataCenterPage } from './pages/DataCenterPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { FranchiseDetailPage } from './pages/FranchiseDetailPage.js';
import { FranchisePage } from './pages/FranchisePage.js';
import { LibraryPage } from './pages/LibraryPage.js';
import { MePage } from './pages/MePage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { ProfilePage } from './pages/ProfilePage.js';
import { SeriesDetailPage } from './pages/SeriesDetailPage.js';
import { SeriesPage } from './pages/SeriesPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { SubjectDetailPage } from './pages/SubjectDetailPage.js';

export function App() {
  useEffect(()=>{
    const refresh=(event:StorageEvent)=>{if(event.key===PRIVACY_EVENT)window.location.reload();};
    const onRestore=(event:PageTransitionEvent)=>{if(event.persisted)window.location.reload();};
    window.addEventListener('storage',refresh);
    window.addEventListener('pageshow',onRestore);
    return ()=>{window.removeEventListener('storage',refresh);window.removeEventListener('pageshow',onRestore);};
  },[]);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 20_000,
            refetchOnWindowFocus: false,
            retry: 1,
            gcTime: 5 * 60_000,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ToastProvider>
          <BrowserRouter>
            <Routes>
              <Route
                element={
                  <WallpaperProvider>
                    <MaterialProvider>
                      <AppShell />
                    </MaterialProvider>
                  </WallpaperProvider>
                }
              >
                <Route index element={<DashboardPage />} />
                <Route path="library" element={<LibraryPage />} />
                <Route path="subjects/:id" element={<SubjectDetailPage />} />
                <Route path="analysis" element={<AnalysisPage />} />
                <Route path="series" element={<SeriesPage />} />
                <Route path="series/:key" element={<SeriesDetailPage />} />
                <Route path="franchises" element={<FranchisePage />} />
                <Route path="franchises/:key" element={<FranchiseDetailPage />} />
                <Route path="profile" element={<ProfilePage />} />
                <Route path="me" element={<MePage />} />
              <Route path="diagnostics" element={<DataCenterPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="404" element={<NotFoundPage />} />
                <Route path="*" element={<Navigate to="/404" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
