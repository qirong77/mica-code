export type ServiceToken<T> = {
  id: string;
};

export function createServiceToken<T>(id: string): ServiceToken<T> {
  return { id };
}
