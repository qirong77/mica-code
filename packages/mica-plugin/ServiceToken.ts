export type ServiceToken<T> = {
  id: string;
  readonly __type?: T;
};

export function createServiceToken<T>(id: string): ServiceToken<T> {
  return { id };
}
