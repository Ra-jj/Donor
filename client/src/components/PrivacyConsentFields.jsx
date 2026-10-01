// The two checkboxes every account needs, used at sign-up and on the consent screen. They are
// separate agreements: both start unticked, neither ticks the other, and the form they sit in
// refuses to go on until both are ticked (lib/privacyConsent.js). Each error is announced when it
// appears (role="alert") and tied to its checkbox with aria-describedby.
const CONSENT_CHECKBOXES = [
  { name: 'acceptPrivacy', label: 'I agree to Donor using my data as described in the Privacy Notice' },
  { name: 'confirmAdult', label: 'I am 18 or older' },
];

// Ids are `${idPrefix}-acceptPrivacy` and `${idPrefix}-confirmAdult`, so a form can focus the
// first box left unticked
const PrivacyConsentFields = ({ idPrefix, values, errors, onChange }) => (
  <div className="space-y-3">
    {CONSENT_CHECKBOXES.map(({ name, label }) => {
      const inputId = `${idPrefix}-${name}`;
      const errorId = `${inputId}-error`;
      const error = errors[name];
      return (
        <div key={name}>
          <label htmlFor={inputId} className="flex items-start gap-3 cursor-pointer text-sm font-medium text-base-content leading-snug">
            <input
              id={inputId}
              type="checkbox"
              className={`checkbox shrink-0 ${error ? 'checkbox-error' : 'checkbox-primary'}`}
              checked={values[name] === true}
              onChange={(event) => onChange(name, event.target.checked)}
              aria-required="true"
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={error ? errorId : undefined}
            />
            <span className="pt-0.5">{label}</span>
          </label>
          {error && (
            <p id={errorId} role="alert" className="text-error text-sm mt-1.5 ml-9 font-medium">
              {error}
            </p>
          )}
        </div>
      );
    })}
  </div>
);

export default PrivacyConsentFields;
