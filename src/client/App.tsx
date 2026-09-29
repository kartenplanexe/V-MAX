import { PlannerForm } from './PlannerForm';
import { ServiceInformationPage } from './ServiceInformation';

export function App() {
  if (new URLSearchParams(window.location.search).get('page') === 'information') return <ServiceInformationPage />;
  return <PlannerForm />;
}
