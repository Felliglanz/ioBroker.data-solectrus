// Local dev sandbox only - not part of the production build copied into admin/custom.
// Mocks just enough of Admin's ConfigCustom props to render the editor standalone via `npm start`.
// Intentionally MUI/gui-components-free: this component only needs { data, attr, onChange, socket,
// theme, themeType, t }, all of which it already treats as optional.
import React, { useState } from 'react';

import DataSolectrusItemsEditor from './DataSolectrusItemsEditor';

const SAMPLE_ITEMS = [
    {
        enabled: true,
        name: 'Sample power value',
        group: 'pv',
        targetId: 'power',
        mode: 'formula',
        sourceState: '',
        jsonPath: '',
        inputs: [],
        formula: '1 + 1',
        rules: [],
        type: 'number',
        role: 'value.power',
        unit: 'W',
        noNegative: false,
        clamp: false,
        min: '',
        max: '',
    },
];

export default function App(): React.JSX.Element {
    const [data, setData] = useState<Record<string, unknown>>({ items: SAMPLE_ITEMS });

    return (
        <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
            <DataSolectrusItemsEditor
                data={data}
                attr="items"
                onChange={(next: Record<string, unknown>) => setData(next)}
                socket={null}
                theme={null}
                themeType="light"
                t={(text: string) => text}
            />
        </div>
    );
}
