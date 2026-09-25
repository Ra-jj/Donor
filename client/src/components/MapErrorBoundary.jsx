import { Component } from 'react';
import { WarningCircleIcon } from '@phosphor-icons/react';
import { isChunkLoadError } from '../lib/chunkLoadError';

// Keeps a DonorMap failure inside the map area. Without it the error reaches RouteErrorBoundary,
// which reloads the page for a failed chunk, and on the create-request success screen that would
// lose the confirmation and invite a duplicate request. No retry button: the browser and
// React.lazy both keep a failed import for the life of the page, so only the next app load brings
// the map back. height is the map's own height class, so the fallback takes the same space.
class MapErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    const { height, note, children } = this.props;
    if (!error) return children;

    // divs, not p: daisyUI gives every p inside a card body flex-grow, which would spread these
    // lines over the whole map area on the create-request success screen
    return (
      <div role="status" className={`${height} flex flex-col items-center justify-center gap-1 px-4 text-center text-base-content/60`}>
        <WarningCircleIcon weight="duotone" className="w-7 h-7 text-warning" />
        <div className="font-semibold text-base-content/80">Map couldn't load</div>
        <div className="text-sm">
          {isChunkLoadError(error)
            ? 'Check your connection. The map shows again next time you open Donor.'
            : 'Something went wrong showing the map.'}
        </div>
        {note && <div className="text-sm font-medium text-base-content/80 mt-1">{note}</div>}
      </div>
    );
  }
}

export default MapErrorBoundary;
