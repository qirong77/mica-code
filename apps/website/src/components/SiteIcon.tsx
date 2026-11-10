interface Props {
  name: 'monitor' | 'terminal' | 'sun' | 'moon';
  size: number;
  className?: string;
}

const paths: Record<Props['name'], string[]> = {
  monitor: ['M3 3h18v14H3z', 'M8 21h8', 'M12 17v4'],
  terminal: ['m4 6 6 6-6 6', 'M12 18h8'],
  sun: [
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
    'M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  ],
  moon: ['M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z'],
};

export default function SiteIcon({ name, size, className }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {paths[name].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}
