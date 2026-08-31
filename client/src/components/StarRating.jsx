import React, { useState } from 'react';
import { Star } from '@phosphor-icons/react';

const StarRating = ({ rating, onRate, interactive = false, size = 'w-6 h-6', className = '' }) => {
  const [hover, setHover] = useState(0);
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
            (hover || rating) >= star ? 'text-warning' : 'text-base-300'
          }`}
          disabled={!interactive}
          aria-label={interactive ? `Rate ${star} stars` : `${rating} out of 5 stars`}
        >
          <Star weight={(hover || rating) >= star ? "fill" : "regular"} className={size} />
        </button>
      ))}
    </div>
  );
};

export default StarRating;
