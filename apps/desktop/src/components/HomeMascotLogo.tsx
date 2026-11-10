import { PetSprite } from "../features/pets/PetSprite";
import { usePetImage, usePetLibrary } from "../features/pets/pet-store";

export function HomeMascotLogo() {
  const { library } = usePetLibrary();
  const pet = library?.pets.find((entry) => entry.id === library.preferences.selectedPet);
  const image = usePetImage(pet?.id ?? null);
  if (!pet || !image) return null;
  return <span className="home-mascot-logo" data-testid="home-mascot-logo" aria-hidden="true">
    <PetSprite pet={pet} dataUrl={image} size={100} animation="waving" decorative />
  </span>;
}
