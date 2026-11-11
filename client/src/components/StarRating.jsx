import { useState } from 'react';
import { StarIcon } from '@phosphor-icons/react';

// Filled stars are the -strong amber everywhere, so every rating looks the same: the plain amber
// measured 2.98:1 on the rating form in the light theme. An empty star the person can click shows
// where to click, so it is stronger too (it measured 1.18:1); a shown rating keeps its soft empty
// stars, with the number written beside them.
const STAR_COLORS = {
  interactive: { filled: 'text-warning-strong', empty: 'text-base-content/60' },
  shown: { filled: 'text-warning-strong', empty: 'text-base-300' },
};

const StarRating = ({ rating, onRate, interactive = false, size = 'w-6 h-6', className = '' }) => {
  const [hover, setHover] = useState(0);
  const colors = interactive ? STAR_COLORS.interactive : STAR_COLORS.shown;
  return (
    <div className={`flex items-center gap-1 ${className}`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          onClick={() => interactive && onRate && onRate(star)}
          onMouseEnter={() => interactive && setHover(star)}
          onMouseLeave={() => interactive && setHover(0)}
          className={`transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-full ${!interactive && 'cursor-default'} ${
            (hover || rating) >= star ? colors.filled : colors.empty
          }`}
          disabled={!interactive}
          aria-label={interactive ? `Rate ${star} stars` : `${rating} out of 5 stars`}
        >
          <StarIcon weight={(hover || rating) >= star ? "fill" : "regular"} className={size} />
        </button>
      ))}
    </div>
  );
};

export default StarRating;
