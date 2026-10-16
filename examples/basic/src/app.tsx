import { useState } from 'react';

const PEOPLE = [
    { id: 1, name: 'Jordan Alvarez', email: 'jordan@example.org' },
    { id: 2, name: 'Ruth Adeyemi', email: 'ruth@example.org' },
];

function PersonRow({ name, email }: { name: string; email: string }) {
    return (
        <li className="person">
            <strong>{name}</strong> <span>{email}</span>
        </li>
    );
}

export function App() {
    const [saved, setSaved] = useState(false);
    return (
        <main>
            <h1>People</h1>
            <ul>
                {PEOPLE.map((p) => (
                    <PersonRow key={p.id} name={p.name} email={p.email} />
                ))}
            </ul>
            <button type="button" onClick={() => setSaved(true)}>
                Save
            </button>
            {saved && <p role="status">Saved</p>}
        </main>
    );
}
