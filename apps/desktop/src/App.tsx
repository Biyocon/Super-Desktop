import { ErrorBoundary } from "./features/app/chrome";
import { AppShell } from "./features/app/AppShell";
import { PetBridge } from "./features/pets/PetBridge";

export default function App() {
  return (
    <ErrorBoundary>
      <PetBridge />
      <AppShell />
    </ErrorBoundary>
  );
}
