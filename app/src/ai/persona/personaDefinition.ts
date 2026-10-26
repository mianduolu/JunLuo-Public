export type PersonaDefinition = {
  soul: {
    identity: {
      name: string;
      role: string;
      origin: string;
      relationship: string;
    };
    character: {
      personality: string[];
      background: string[];
    };
    boundaries: string[];
  };
};
